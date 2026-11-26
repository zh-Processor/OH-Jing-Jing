export interface ImChannelSettings {
  pluginId?: string;
  address: string;
  enabled: boolean;
  groups: string[];
  roleId: string;
  modelId: string;
  hasToken: boolean;
  paused?: boolean;
  cooldownSeconds?: number;
  ownerId?: string;
  expectedBotId?: string;
  verifyExpectedBot?: boolean;
  recoverHistory?: boolean;
  qqAccountContract?: "ohjingjing-v1";
}

export type ChannelStatus = "disabled" | "connecting" | "online" | "disconnected";
export type ChannelConnectionIssue = {
  kind: "authorization" | "account-mismatch" | "login-unconfirmed" | "gateway-offline" | "heartbeat-timeout" |
    "transport-error" | "connection-closed";
  detectedAt: string;
};
export type DeliveryStatus = "sent" | "unknown" | "failed";
export type GroupExpressionAsset = { kind: "qq-face"; id: number } | { kind: "image"; base64: string };
export type GroupDeliveryFormat = "voice" | GroupExpressionAsset["kind"];
export type GroupDelivery = { status: DeliveryStatus; messageId?: string; format?: GroupDeliveryFormat };

export type IncomingGroupMessage = {
  kind: "group";
  accountId: string;
  groupId: string;
  messageId: string;
  actorId: string;
  name: string;
  message: string;
  referenceId?: string;
  hasImage: boolean;
  images?: string[];
  imageCount?: number;
  hasVoice?: true;
  hasForward?: true;
  voiceOnly?: true;
  pingOnly: boolean;
  addressed: boolean;
  directed: boolean;
  bot: boolean;
};

export type IncomingPrivateMessage = {
  kind: "private";
  accountId: string;
  messageId: string;
  actorId: string;
  message: string;
  referenceId?: string;
  images?: string[];
  hasImage?: boolean;
  imageCount?: number;
  hasVoice?: true;
  hasForward?: true;
  voiceOnly?: true;
};

export type ChannelMessage = IncomingGroupMessage | IncomingPrivateMessage;
export type IncomingGroupRecall = {
  kind: "group-recall";
  accountId: string;
  groupId: string;
  actorId: string;
  messageId: string;
};
export type ChannelAccount = { id: string; nickname: string };
export type ChannelHistoryRead = { since: number; before?: number; stillAllowed?: () => boolean; onIncomplete?: (before?: number) => void };

export interface ImChannelGateway {
  readonly status: ChannelStatus;
  readonly connectionIssue?: ChannelConnectionIssue | null;
  start(settings: ImChannelSettings, token: string | null, inbound: (message: ChannelMessage) => void, onDisconnect?: () => void,
    onStatusChange?: () => void, onGroupRecall?: (recall: IncomingGroupRecall) => void): void;
  stop(): void;
  checkLogin(): Promise<{ status: "confirmed" | "unknown" | "failed"; account: ChannelAccount | null }>;
  deliverGroup?(groupId: string, content: string, stillAllowed?: () => boolean): Promise<GroupDelivery>;
  deliverGroupExpression?(groupId: string, content: string, asset: GroupExpressionAsset, stillAllowed?: () => boolean): Promise<GroupDelivery>;
  sendPrivate?(actorId: string, content: string, stillAllowed?: () => boolean): Promise<DeliveryStatus>;
  deliverPrivate?(actorId: string, content: string, stillAllowed?: () => boolean): Promise<GroupDelivery>;
  readRecentGroup?(groupId: string, accountId: string, history?: ChannelHistoryRead): Promise<{ message: IncomingGroupMessage; at: number }[] | null>;
  readRecentPrivate?(userId: string, accountId: string, history?: ChannelHistoryRead): Promise<{ message: IncomingPrivateMessage; at: number }[] | null>;
}

export type ImChannelManifest = {
  id: string;
  name: string;
  platform: "qq" | "wechat";
  apiVersion: 1;
  capabilities: readonly ("groupText" | "groupExpressions" | "privateText" | "voiceInput" | "voiceOutput" | "qqProfile" | "qqSpace")[];
};

export type ImChannelStatus = ImChannelManifest & {
  status: ChannelStatus;
  configured: boolean;
  enabled: boolean;
};

export interface ImChannelPlugin {
  manifest: ImChannelManifest;
  create(settings: ImChannelSettings | undefined): ImChannelGateway;
}
