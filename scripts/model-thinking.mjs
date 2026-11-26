const deepSeekOrigins = new Set(["https://api.deepseek.com", "https://cf.api.fan", "https://slb-v1.api.fan"]);
const deepSeekModels = new Set(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"]);

export function maximumThinkingFormat(origin, model) {
  if (deepSeekOrigins.has(origin) && deepSeekModels.has(model)) return "deepseek";
  if (origin === "https://openrouter.ai" &&
      /^deepseek\/deepseek-v4(?:-pro|-flash|\.1-flash)(?:-\d{4,8})?$/u.test(model)) return "openrouter";
}
