import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { readInstances, type InstanceEntry, type InstancePreflightFailure, type InstanceStartupResult } from "./instance-config.js";
import { openInstanceRevisions } from "./instance-revisions.js";
import { superviseInstances, type InstanceAction } from "./instance-supervisor.js";

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(data));
}

async function requestJson(req: IncomingMessage) {
  if (!/^application\/json(?:;|$)/iu.test(req.headers["content-type"] ?? "")) throw new Error("仅接收 JSON 请求。");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4096) throw new Error("版本发布请求过大。");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function startupChecks(entry: InstanceEntry, previous: InstanceEntry): NodeJS.ProcessEnv {
  const checkGateway = !!entry.gateway && entry.gateway !== previous.gateway;
  const checkIngress = !!entry.qqIngress && (checkGateway || entry.qqIngress !== previous.qqIngress);
  return {
    OHJINGJING_CONFIG_CHECK_GATEWAY: checkGateway ? "1" : undefined,
    OHJINGJING_CONFIG_CHECK_INGRESS: checkIngress ? "1" : undefined,
    OHJINGJING_CONFIG_CHECK_QQ_CAPABILITIES: checkGateway ? JSON.stringify(entry.requiredQqCapabilities) : undefined,
  };
}

function preflight(entry: InstanceEntry, checks: NodeJS.ProcessEnv, serverEntry: string, execArgv: string[]) {
  return new Promise<InstanceStartupResult>(done => {
    const child = spawn(process.execPath, [...execArgv, serverEntry], {
      env: { ...entry.env, ...checks, OHJINGJING_CONFIG_CHECK: "1" },
      windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const timeout = setTimeout(() => child.kill(), 20_000).unref();
    let failure: InstancePreflightFailure | undefined;
    child.on("message", message => { failure = (message as { preflightFailure?: InstancePreflightFailure })?.preflightFailure; });
    child.once("close", status => {
      clearTimeout(timeout);
      done({ ok: status === 0, failure });
    });
    child.once("error", () => done({ ok: false }));
  });
}

function startupError(failure: InstancePreflightFailure | undefined, generic: string) {
  if (failure?.kind === "gateway") return { error: "候选网关未通过 QQ 登录账号核对。" };
  if (failure?.kind === "ingress") return { error: "候选配置的 QQ 独立收件未在线，或账号和协议不匹配。" };
  if (failure?.kind === "qq-capabilities") return {
    error: `候选网关缺少已配置的 QQ 能力（${failure.missing.join("、")}）。`, missingCapabilities: failure.missing,
  };
  return { error: generic };
}

const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OHJingJing 实例管理</title>
<style>body{margin:2rem auto;padding:0 1.25rem;max-width:54rem;background:#f6f5ef;color:#18382e;font:16px system-ui}
input,button{font:inherit;padding:.46rem;margin:.25rem;border:1px solid #486958;border-radius:.4rem}button{background:#225743;color:white}
button:disabled{opacity:.55}article{background:white;padding:1rem;margin:.65rem 0;border-radius:.65rem}h2{margin:0;font-size:1.2rem}
a{color:#175641;margin-right:.4rem}dialog{border:1px solid #486958;border-radius:.65rem;max-width:min(42rem,85vw);overflow-wrap:anywhere}
dialog::backdrop{background:#18382e66}dialog li{margin:.4rem 0}</style>
<h1>OHJingJing 实例管理</h1><form id="login"><label>管理令牌 <input id="token" type="password" autocomplete="off" required></label>
<button type="submit">刷新实例</button></form><p id="status" role="status"></p><section id="instances" aria-label="机器人实例"></section>
<dialog id="config" aria-labelledby="configTitle">
  <form method="dialog"><button>关闭</button></form>
  <h2 id="configTitle">实例配置版本</h2><p id="configSource"></p>
  <p id="configStatus" role="status"></p>
  <button type="button" id="configPublish" disabled>发布磁盘上的配置</button>
  <button type="button" id="configRefresh">刷新版本</button>
  <ol id="configHistory" aria-label="版本历史"></ol>
</dialog>
<script>
const token=document.getElementById('token'), status=document.getElementById('status'), items=document.getElementById('instances');
const config=document.getElementById('config'), source=document.getElementById('configSource'), configStatus=document.getElementById('configStatus');
const publish=document.getElementById('configPublish'), history=document.getElementById('configHistory');
let opened=null, configRevision=0, configBusy=false;
let revision=0, active=false, busy=false;
const names={stopped:'已停止', starting:'启动中', running:'运行中', stopping:'停止中', waiting:'等待重启'};
const actions={start:'启动', stop:'停止', restart:'重启'};
function render(instances) {
  items.replaceChildren(...instances.map(instance=>{
    const card=document.createElement('article');
    const title=document.createElement('h2'); title.textContent=instance.name;
    const detail=document.createElement('p'); detail.textContent=(instance.updating ? '正在发布配置 · ' : '') + names[instance.state] +
      (instance.retryAt ? ' · 下次尝试 ' + new Date(instance.retryAt).toLocaleTimeString() : '') +
      (instance.lastExit ? ' · 上次退出码 ' + instance.lastExit : '');
    card.append(title,detail);
    if(instance.state==='running') {
      const link=document.createElement('a'); link.href=instance.address; link.target='_blank'; link.rel='noopener';
      link.textContent='打开运营后台'; card.append(link);
    }
    for(const action of Object.keys(actions)) {
      const button=document.createElement('button'); button.type='button'; button.textContent=actions[action];
      button.disabled=instance.updating || (action==='start' ? instance.wanted : !instance.wanted || instance.state==='stopping');
      button.onclick=()=>void load(instance.id,action); card.append(button);
    }
    const settings=document.createElement('button'); settings.type='button'; settings.textContent='配置版本';
    settings.onclick=()=>{
      opened=instance.id; document.getElementById('configTitle').textContent=instance.name+' · 配置版本';
      config.showModal(); void readConfig();
    };
    card.append(settings);
    return card;
  }));
}
async function load(id,action) {
  if(busy) return;
  busy=true;
  const now=++revision;
  try {
    const path='/api/instances'+(id?'/'+encodeURIComponent(id)+'/'+action:'');
    const reply=await fetch(path,{method:id?'POST':'GET',headers:{Authorization:'Bearer '+token.value.trim()}});
    if(now!==revision) return;
    const body=await reply.json(); if(now!==revision) return;
    if(!reply.ok) throw new Error(body.error || '权限校验或实例操作失败。');
    active=true; status.textContent=id?'已提交'+actions[action]+'。':''; render(body.instances);
  } catch (error) {
    if(now!==revision) return;
    active=false; items.replaceChildren(); status.textContent=error instanceof Error ? error.message : '无法连接实例管理。';
  } finally { busy=false; }
}
function renderConfig(view) {
  source.textContent='配置文件 '+view.sourceFile;
  configStatus.textContent='当前版本 '+view.version+'。'+(view.draftHash===null ? '配置文件无法读取或存在无效字段。' :
    view.changed ? '磁盘上的配置有待发布的修改。' : '磁盘上的配置与当前版本一致。');
  publish.disabled=!view.changed;
  publish.onclick=()=>void readConfig({expectedVersion:view.version,draftHash:view.draftHash});
  const op={baseline:'初始版本',publish:'发布',rollback:'回滚'};
  history.replaceChildren(...view.revisions.map(item=>{
    const line=document.createElement('li');
    line.textContent='版本 '+item.version+' · '+op[item.operation]+' · '+new Date(item.at).toLocaleString();
    if (item.version!==view.version && item.hash!==view.revision) {
      const button=document.createElement('button'); button.type='button'; button.textContent='回滚到版本 '+item.version;
      button.onclick=()=>void readConfig({expectedVersion:view.version,restoreVersion:item.version}); line.append(button);
    }
    return line;
  }));
}
async function readConfig(payload) {
  if (!opened || configBusy) return;
  const seq=++configRevision;
  configBusy=true; publish.disabled=true; history.replaceChildren();
  configStatus.textContent=payload?'正在验证并切换配置…':'正在读取…';
  try {
    const options={method:payload?'PUT':'GET',headers:{Authorization:'Bearer '+token.value.trim(),'Content-Type':'application/json'},
      ...(payload?{body:JSON.stringify(payload)}:{})};
    const response=await fetch('/api/instances/'+encodeURIComponent(opened)+'/config',options);
    const body=await response.json();
    if(seq!==configRevision) return;
    if(!response.ok) throw new Error(body.error||'配置操作失败。');
    renderConfig(body);
    if(payload) void load();
  } catch(error) {
    if(seq===configRevision) configStatus.textContent=error instanceof Error ? error.message : '无法连接实例管理。';
  } finally {
    configBusy=false;
    if(seq!==configRevision && opened) void readConfig();
  }
}
config.onclose=()=>{configRevision++;opened=null;source.textContent='';configStatus.textContent='';history.replaceChildren();};
document.getElementById('configRefresh').onclick=()=>void readConfig();
document.getElementById('login').onsubmit=event=>{event.preventDefault(); void load();};
token.oninput=()=>{revision++;active=false;items.replaceChildren();status.textContent='';if(config.open)config.close();};
setInterval(()=>{if(active) void load();},3000);
</script></html>`;

function run() {
  const path = process.argv[2];
  const mode = process.argv[3];
  if (!path || process.argv.length > 4 || (mode !== undefined && mode !== "--check")) {
    throw new Error("用法 node instances.cjs instances.json [--check]");
  }
  const manifest = resolve(path);
  const revisions = openInstanceRevisions(manifest);
  const { entries, port, token, manifestHash } = readInstances(manifest, process.env, revisions.selected());
  revisions.verifySources(entries);
  if (mode === "--check") {
    process.stdout.write(JSON.stringify({ valid: true, instances: entries.map(({ id, address, start }) => ({ id, address, start })) }) + "\n");
    return;
  }
  const bundled = extname(process.argv[1]) === ".cjs";
  const serverEntry = join(dirname(resolve(process.argv[1])), bundled ? "server.cjs" : "server.ts");
  const execArgv = bundled ? [] : ["--import", "tsx"];
  const supervisor = superviseInstances(entries, serverEntry, execArgv);
  const admin = createHash("sha256").update(token).digest();
  let closing = false;
  let publishing = false;
  async function config(req: IncomingMessage, res: ServerResponse, id: string) {
    if (!["GET", "PUT"].includes(req.method ?? "")) return json(res, 405, { error: "此接口支持读取或发布版本。" });
    const find = () => supervisor.entries().find(entry => entry.id === id);
    const entry = find();
    if (!entry) return json(res, 404, { error: "找不到实例。" });
    if (req.method === "GET") return json(res, 200, revisions.view(entry));
    const payload = await requestJson(req);
    const { expectedVersion, draftHash, restoreVersion } = payload ?? {};
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
        (restoreVersion === undefined ? typeof draftHash !== "string" || !/^[a-f0-9]{64}$/u.test(draftHash) :
          !Number.isSafeInteger(restoreVersion) || restoreVersion < 0 || draftHash !== undefined)) {
      return json(res, 400, { error: "请提供当前版本和待发布配置指纹，或选择需要回滚的版本。" });
    }
    if (closing || publishing || expectedVersion !== revisions.version(id)) {
      return json(res, 409, { error: "配置版本已变化或正在发布，请刷新后重试。" });
    }
    publishing = true;
    try {
      let draft;
      if (restoreVersion === undefined) {
        draft = revisions.draft(entry);
        if (draft.expectedHash !== draftHash) return json(res, 409, { error: "待发布配置已变化，请刷新后重试。" });
      }
      const target = draft ? revisions.store(draft.value) : revisions.fileAt(id, restoreVersion);
      if (!target) return json(res, 404, { error: "找不到要回滚的配置版本。" });
      const selected = new Map(supervisor.entries().map(current => [current.id, revisions.saveCurrent(current)]));
      const readSelected = (files: Map<string, string>) => {
        const loaded = readInstances(manifest, process.env, files, manifestHash).entries;
        revisions.verifySources(loaded);
        return loaded.find(item => item.id === id)!;
      };
      const previous = readSelected(selected);
      selected.set(id, target);
      const candidate = readSelected(selected);
      if (candidate.databaseKey !== previous.databaseKey || candidate.account !== previous.account) {
        return json(res, 400, { error: "配置版本须沿用当前实例的数据库和 QQ 账号。更换账号请建立独立实例。" });
      }
      if (candidate.hash === previous.hash) return json(res, 200, revisions.view(entry));
      const checks = startupChecks(candidate, previous);
      const checked = await preflight(candidate, checks, serverEntry, execArgv);
      if (!checked.ok) return json(res, 422, startupError(checked.failure, "配置未通过启动预检。请检查渠道、角色、模型和环境变量。"));
      if (closing) return json(res, 409, { error: "实例管理器正在关闭。" });
      revisions.adoptBaseline(entry, previous.configFile);
      const applied = await supervisor.publish(candidate, previous, { checks, commit: () => revisions.commit(candidate, restoreVersion) });
      if (!applied.ok) {
        const reason = startupError(applied.failure, "新配置未能启动。请检查实例端口和状态。");
        return json(res, 409, { ...reason, error: `${reason.error} 仍以原版本为生效配置。` });
      }
      return json(res, 200, revisions.view(candidate));
    } finally { publishing = false; }
  }
  const web = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'" });
      res.end(page);
      return;
    }
    const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_.~-]+)$/u)?.[1];
    if (!bearer || !timingSafeEqual(admin, createHash("sha256").update(bearer).digest())) {
      return json(res, 401, { error: "需要实例管理令牌。" });
    }
    if (req.method === "GET" && path === "/api/instances") return json(res, 200, { instances: supervisor.list() });
    const settings = /^\/api\/instances\/([a-z][a-z0-9-]{0,31})\/config$/u.exec(path);
    if (settings) {
      void config(req, res, settings[1]).catch(error => {
        if (!res.headersSent) json(res, 400, { error: error instanceof Error && /^(?:实例 |实例清单|实例配置中的凭据|仅接收|版本发布|服务端配置)/u
          .test(error.message) ? error.message : "实例配置无法读取或保存，请检查文件格式和目录权限。" });
      });
      return;
    }
    const operation = /^\/api\/instances\/([a-z][a-z0-9-]{0,31})\/(start|stop|restart)$/u.exec(path);
    if (req.method === "POST" && operation) {
      const result = supervisor.control(operation[1], operation[2] as InstanceAction);
      if (result === "busy") return json(res, 409, { error: "实例正在发布配置。" });
      if (result === "changed") return json(res, 409, { error: "实例配置已更新，请重新启动实例管理以校验新配置。" });
      if (result === "accepted") return json(res, 202, { instances: supervisor.list() });
    }
    return json(res, 404, { error: "找不到实例或操作。" });
  });
  async function close() {
    if (closing) return;
    closing = true;
    web.close();
    web.closeAllConnections();
    await supervisor.close();
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void close());
  // The parent application and the Windows integration harness can request graceful shutdown over IPC.
  if (process.send) {
    process.on("message", message => { if (message === "shutdown") void close().then(() => process.disconnect?.()); });
    process.once("disconnect", () => void close());
  }
  web.once("error", () => {
    process.stderr.write("实例管理端口无法监听。\n");
    process.exitCode = 1;
    void close().then(() => { if (process.connected) process.disconnect?.(); });
  });
  web.listen(port, "127.0.0.1", () => {
    supervisor.start();
    process.stdout.write(`OHJingJing instance manager listening on http://127.0.0.1:${port}\n`);
  });
}

try { run(); }
catch (error) {
  process.stderr.write((error instanceof Error ? error.message : "实例管理启动失败。") + "\n");
  process.exitCode = 1;
}
