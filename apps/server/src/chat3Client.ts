import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { config } from './config.js';

function toStruct(obj?: Record<string, unknown>): any {
  if (!obj) return undefined;
  const fields: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') fields[key] = { stringValue: value };
    else if (typeof value === 'number') fields[key] = { numberValue: value };
    else if (typeof value === 'boolean') fields[key] = { boolValue: value };
    else if (value == null) fields[key] = { nullValue: 0 };
    else fields[key] = { stringValue: String(value) };
  }
  return { fields };
}

/** Product convention: stable pairwise key for 1:1 chats (not a Chat3 concept). */
export function buildDmKey(userA: string, userB: string): string {
  const [a, b] = [String(userA).trim().toLowerCase(), String(userB).trim().toLowerCase()].sort();
  return `${a}:${b}`;
}

export class Chat3Client {
  private client: any;
  private metadata: grpc.Metadata;

  constructor() {
    if (!config.chat3.apiKey) {
      throw new Error('CHAT3_API_KEY is required');
    }
    const def = protoLoader.loadSync(config.protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    });
    const pkg = grpc.loadPackageDefinition(def) as any;
    const Service = pkg.chat3.user.Chat3UserService;
    this.client = new Service(config.chat3.grpcUrl, grpc.credentials.createInsecure());
    this.metadata = new grpc.Metadata();
    this.metadata.add('x-api-key', config.chat3.apiKey);
    this.metadata.add('x-tenant-id', config.chat3.tenantId);
  }

  private unary(method: string, request: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      this.client[method](request, this.metadata, (err: Error | null, res: any) => {
        if (err) reject(err);
        else resolve(res);
      });
    });
  }

  upsertUser(userId: string, name: string) {
    return this.unary('UpsertUser', { user_id: userId, name, type: 'user' });
  }

  getUser(userId: string) {
    return this.unary('GetUser', { user_id: userId });
  }

  getUserDialogs(userId: string) {
    return this.unary('GetUserDialogs', {
      user_id: userId,
      page: 1,
      limit: 50,
      include_last_message: true
    });
  }

  getDialogMessages(userId: string, dialogId: string) {
    return this.unary('GetDialogMessages', {
      user_id: userId,
      dialog_id: dialogId,
      page: 1,
      limit: 100,
      sort: '{"createdAt":1}'
    });
  }

  sendMessage(userId: string, dialogId: string, content: string) {
    return this.unary('SendMessage', {
      user_id: userId,
      dialog_id: dialogId,
      content,
      type: 'internal.text'
    });
  }

  findDialogByMeta(userId: string, metaKey: string, metaValue: string) {
    return this.unary('FindDialogByMeta', {
      user_id: userId,
      meta_key: metaKey,
      meta_value: metaValue
    });
  }

  createDialog(userId: string, memberUserIds: string[], meta: Record<string, unknown>) {
    return this.unary('CreateDialog', {
      user_id: userId,
      member_user_ids: memberUserIds,
      meta: toStruct(meta)
    });
  }

  /**
   * Product-level 1:1 open: find by dmKey meta, else CreateDialog.
   * Chat3 only sees dialog + meta; DM semantics stay here.
   */
  async getOrCreateDm(userId: string, peerUserId: string) {
    const dmKey = buildDmKey(userId, peerUserId);
    const existing = await this.findDialogByMeta(userId, 'dmKey', dmKey);
    if (existing?.found && existing.dialog) {
      return { created: false, dialog: existing.dialog };
    }

    const created = await this.createDialog(userId, [peerUserId], {
      type: 'dm',
      dmKey
    });

    // Race: another request may have created the same dmKey first.
    const again = await this.findDialogByMeta(userId, 'dmKey', dmKey);
    if (again?.found && again.dialog) {
      const winnerId = again.dialog.dialog_id || again.dialog.dialogId;
      const createdId = created.dialog?.dialog_id || created.dialog?.dialogId;
      if (winnerId && createdId && winnerId !== createdId) {
        return { created: false, dialog: again.dialog };
      }
      return { created: Boolean(created.created), dialog: again.dialog };
    }

    return { created: true, dialog: created.dialog };
  }

  addDialogMembers(userId: string, dialogId: string, memberUserIds: string[]) {
    return this.unary('AddDialogMembers', {
      user_id: userId,
      dialog_id: dialogId,
      member_user_ids: memberUserIds
    });
  }

  removeDialogMember(userId: string, dialogId: string, memberUserId: string) {
    return this.unary('RemoveDialogMember', {
      user_id: userId,
      dialog_id: dialogId,
      member_user_id: memberUserId
    });
  }

  getDialog(userId: string, dialogId: string) {
    return this.unary('GetDialog', {
      user_id: userId,
      dialog_id: dialogId
    });
  }

  listDialogMembers(dialogId: string, page = 1, limit = 100) {
    return this.unary('ListDialogMembers', {
      dialog_id: dialogId,
      page,
      limit
    });
  }

  updateDialogMeta(userId: string, dialogId: string, meta: Record<string, unknown>) {
    return this.unary('UpdateDialogMeta', {
      user_id: userId,
      dialog_id: dialogId,
      meta: toStruct(meta)
    });
  }

  markDialogAllRead(userId: string, dialogId: string) {
    return this.unary('MarkDialogAllRead', {
      user_id: userId,
      dialog_id: dialogId
    });
  }

  sendTyping(userId: string, dialogId: string) {
    return this.unary('SendTypingIndicator', {
      user_id: userId,
      dialog_id: dialogId
    });
  }

  subscribeUpdates(userId: string): grpc.ClientReadableStream<any> {
    return this.client.SubscribeUpdates({ user_id: userId }, this.metadata);
  }

  /**
   * Firehose stream. Empty tenantIds = all tenants (wildcard).
   */
  subscribeTenantUpdates(tenantIds: string[] = []): grpc.ClientReadableStream<any> {
    const meta = new grpc.Metadata();
    meta.add('x-api-key', config.chat3.apiKey);
    return this.client.SubscribeTenantUpdates({ tenant_ids: tenantIds }, meta);
  }

  /** Bidi WatchUpdates — metadata api-key only. */
  watchUpdates(): grpc.ClientDuplexStream<any, any> {
    const meta = new grpc.Metadata();
    meta.add('x-api-key', config.chat3.apiKey);
    return this.client.WatchUpdates(meta);
  }
}
