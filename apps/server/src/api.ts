import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { LocalUser } from './models/LocalUser.js';
import { authMiddleware, signToken, type AuthedRequest } from './auth.js';
import type { Chat3Client } from './chat3Client.js';

/** google.protobuf.Struct from @grpc/proto-loader → plain object */
function fromStruct(value: any): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  if (value.fields && typeof value.fields === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value.fields as Record<string, any>)) {
      if (v == null) continue;
      if (Object.prototype.hasOwnProperty.call(v, 'stringValue')) out[k] = v.stringValue;
      else if (Object.prototype.hasOwnProperty.call(v, 'numberValue')) out[k] = v.numberValue;
      else if (Object.prototype.hasOwnProperty.call(v, 'boolValue')) out[k] = v.boolValue;
      else if (Object.prototype.hasOwnProperty.call(v, 'nullValue')) out[k] = null;
      else if (v.structValue) out[k] = fromStruct(v.structValue);
      else if (v.listValue?.values) {
        out[k] = v.listValue.values.map((item: any) => {
          if (item.stringValue !== undefined) return item.stringValue;
          if (item.numberValue !== undefined) return item.numberValue;
          if (item.boolValue !== undefined) return item.boolValue;
          if (item.structValue) return fromStruct(item.structValue);
          return item;
        });
      } else out[k] = v;
    }
    return out;
  }
  return value as Record<string, unknown>;
}

function mapDialog(d: any) {
  return {
    dialogId: d.dialog_id,
    meta: fromStruct(d.meta),
    createdAt: d.created_at,
    memberUserIds: d.member_user_ids || [],
    lastMessage: d.last_message
      ? {
          messageId: d.last_message.message_id,
          content: d.last_message.content,
          senderId: d.last_message.sender_id,
          createdAt: d.last_message.created_at,
          type: d.last_message.type
        }
      : null,
    unreadCount: d.member?.state?.unread_count || 0
  };
}

export function createApiRouter(chat3: Chat3Client): Router {
  const router = Router();

  router.post('/auth/register', async (req, res) => {
    try {
      const login = String(req.body.login || '').trim().toLowerCase();
      const name = String(req.body.name || '').trim();
      const password = String(req.body.password || '');
      if (!login || !name || password.length < 4) {
        res.status(400).json({ error: 'login, name and password (min 4) required' });
        return;
      }
      const existing = await LocalUser.findOne({ login });
      if (existing) {
        res.status(409).json({ error: 'User already exists' });
        return;
      }
      const passwordHash = await bcrypt.hash(password, 10);
      await LocalUser.create({ login, name, passwordHash });
      await chat3.upsertUser(login, name);
      const token = signToken({ login, name });
      res.status(201).json({ token, user: { login, name } });
    } catch (error: any) {
      console.error('register', error);
      res.status(500).json({ error: error?.message || 'register failed' });
    }
  });

  router.post('/auth/login', async (req, res) => {
    try {
      const login = String(req.body.login || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      const user = await LocalUser.findOne({ login });
      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      await chat3.upsertUser(user.login, user.name);
      const token = signToken({ login: user.login, name: user.name });
      res.json({ token, user: { login: user.login, name: user.name } });
    } catch (error: any) {
      console.error('login', error);
      res.status(500).json({ error: error?.message || 'login failed' });
    }
  });

  router.get('/me', authMiddleware, (req: AuthedRequest, res) => {
    res.json({ user: req.user });
  });

  router.get('/users', authMiddleware, async (_req, res) => {
    const users = await LocalUser.find().select('login name').lean();
    res.json({ users });
  });

  router.get('/dialogs', authMiddleware, async (req: AuthedRequest, res) => {
    try {
      const result = await chat3.getUserDialogs(req.user!.login);
      const dialogs = (result.dialogs || []).map(mapDialog);
      res.json({ dialogs });
    } catch (error: any) {
      console.error('dialogs', error);
      res.status(500).json({ error: error?.details || error?.message || 'failed' });
    }
  });

  router.post('/dm', authMiddleware, async (req: AuthedRequest, res) => {
    try {
      const peerLogin = String(req.body.peerLogin || '').trim().toLowerCase();
      if (!peerLogin) {
        res.status(400).json({ error: 'peerLogin required' });
        return;
      }
      if (peerLogin === req.user!.login) {
        res.status(400).json({ error: 'Cannot DM yourself' });
        return;
      }
      const peer = await LocalUser.findOne({ login: peerLogin });
      if (!peer) {
        res.status(404).json({ error: 'Peer user not found (must be registered)' });
        return;
      }
      await chat3.upsertUser(peer.login, peer.name);
      const result = await chat3.getOrCreateDm(req.user!.login, peerLogin);
      res.json({
        created: result.created,
        dialog: mapDialog(result.dialog)
      });
    } catch (error: any) {
      console.error('dm', error);
      res.status(500).json({ error: error?.details || error?.message || 'failed' });
    }
  });

  router.post('/groups', authMiddleware, async (req: AuthedRequest, res) => {
    try {
      const title = String(req.body.title || '').trim();
      const memberLogins = Array.isArray(req.body.memberLogins)
        ? req.body.memberLogins.map((x: string) => String(x).trim().toLowerCase()).filter(Boolean)
        : [];
      if (!title) {
        res.status(400).json({ error: 'title required' });
        return;
      }
      for (const login of memberLogins) {
        const u = await LocalUser.findOne({ login });
        if (!u) {
          res.status(404).json({ error: `User not found: ${login}` });
          return;
        }
        await chat3.upsertUser(u.login, u.name);
      }
      const result = await chat3.createDialog(req.user!.login, memberLogins, {
        type: 'group',
        title
      });
      res.status(201).json({
        dialog: mapDialog(result.dialog)
      });
    } catch (error: any) {
      console.error('groups', error);
      res.status(500).json({ error: error?.details || error?.message || 'failed' });
    }
  });

  router.get('/dialogs/:dialogId/messages', authMiddleware, async (req: AuthedRequest, res) => {
    try {
      const result = await chat3.getDialogMessages(req.user!.login, req.params.dialogId);
      const messages = (result.messages || []).map((m: any) => {
        const senderMeta = fromStruct(m.sender_info?.meta);
        const statuses = (m.statuses || []).map((s: any) => ({
          userId: s.user_id,
          status: s.status,
          createdAt: s.created_at,
          readAt: s.read_at
        }));
        return {
          messageId: m.message_id,
          dialogId: m.dialog_id,
          senderId: m.sender_id,
          content: m.content,
          type: m.type,
          createdAt: m.created_at,
          deleted: m.deleted === true,
          senderName: (senderMeta.name as string) || m.sender_info?.name || m.sender_id,
          statuses
        };
      });
      res.json({ messages });
    } catch (error: any) {
      console.error('messages', error);
      res.status(500).json({ error: error?.details || error?.message || 'failed' });
    }
  });

  router.post('/dialogs/:dialogId/read', authMiddleware, async (req: AuthedRequest, res) => {
    try {
      await chat3.markDialogAllRead(req.user!.login, req.params.dialogId);
      res.json({ ok: true });
    } catch (error: any) {
      console.error('mark-read', error);
      res.status(500).json({ error: error?.details || error?.message || 'failed' });
    }
  });

  router.post('/dialogs/:dialogId/typing', authMiddleware, async (req: AuthedRequest, res) => {
    try {
      const result = await chat3.sendTyping(req.user!.login, req.params.dialogId);
      res.json({
        ok: true,
        expiresInMs: result.expires_in_ms || 5000
      });
    } catch (error: any) {
      console.error('typing', error);
      res.status(500).json({ error: error?.details || error?.message || 'failed' });
    }
  });

  router.get('/dialogs/:dialogId', authMiddleware, async (req: AuthedRequest, res) => {
    try {
      const result = await chat3.getDialog(req.user!.login, req.params.dialogId);
      res.json({ dialog: mapDialog(result.dialog) });
    } catch (error: any) {
      console.error('get-dialog', error);
      const code = String(error?.code || '');
      if (code.includes('PERMISSION') || code.includes('7') || /not a member/i.test(error?.details || error?.message || '')) {
        res.status(403).json({ error: error?.details || error?.message || 'forbidden' });
        return;
      }
      res.status(500).json({ error: error?.details || error?.message || 'failed' });
    }
  });

  router.get('/dialogs/:dialogId/members', authMiddleware, async (req: AuthedRequest, res) => {
    try {
      // membership gate via GetDialog
      await chat3.getDialog(req.user!.login, req.params.dialogId);
      const result = await chat3.listDialogMembers(req.params.dialogId);
      const memberUserIds: string[] = result.member_user_ids || [];
      const users = await LocalUser.find({ login: { $in: memberUserIds } })
        .select('login name')
        .lean();
      const byLogin = new Map(users.map((u) => [u.login, u.name]));
      res.json({
        members: memberUserIds.map((login) => ({
          login,
          name: byLogin.get(login) || login
        })),
        total: result.total || memberUserIds.length
      });
    } catch (error: any) {
      console.error('members', error);
      res.status(500).json({ error: error?.details || error?.message || 'failed' });
    }
  });

  router.post('/dialogs/:dialogId/members', authMiddleware, async (req: AuthedRequest, res) => {
    try {
      const dialogRes = await chat3.getDialog(req.user!.login, req.params.dialogId);
      const meta = fromStruct(dialogRes.dialog?.meta);
      if (meta.type === 'dm') {
        res.status(400).json({ error: 'Cannot add members to a DM' });
        return;
      }
      const logins = Array.isArray(req.body.memberLogins)
        ? req.body.memberLogins.map((x: string) => String(x).trim().toLowerCase()).filter(Boolean)
        : [];
      if (!logins.length) {
        res.status(400).json({ error: 'memberLogins required' });
        return;
      }
      for (const login of logins) {
        const u = await LocalUser.findOne({ login });
        if (!u) {
          res.status(404).json({ error: `User not found: ${login}` });
          return;
        }
        await chat3.upsertUser(u.login, u.name);
      }
      const result = await chat3.addDialogMembers(req.user!.login, req.params.dialogId, logins);
      res.json({
        dialog: mapDialog(result.dialog),
        addedUserIds: result.added_user_ids || []
      });
    } catch (error: any) {
      console.error('add-members', error);
      res.status(500).json({ error: error?.details || error?.message || 'failed' });
    }
  });

  router.delete('/dialogs/:dialogId/members/:memberLogin', authMiddleware, async (req: AuthedRequest, res) => {
    try {
      const dialogRes = await chat3.getDialog(req.user!.login, req.params.dialogId);
      const meta = fromStruct(dialogRes.dialog?.meta);
      if (meta.type === 'dm') {
        res.status(400).json({ error: 'Cannot remove members from a DM' });
        return;
      }
      const memberLogin = String(req.params.memberLogin || '').trim().toLowerCase();
      const result = await chat3.removeDialogMember(
        req.user!.login,
        req.params.dialogId,
        memberLogin
      );
      res.json({ dialog: mapDialog(result.dialog) });
    } catch (error: any) {
      console.error('remove-member', error);
      res.status(500).json({ error: error?.details || error?.message || 'failed' });
    }
  });

  router.patch('/dialogs/:dialogId', authMiddleware, async (req: AuthedRequest, res) => {
    try {
      const dialogRes = await chat3.getDialog(req.user!.login, req.params.dialogId);
      const meta = fromStruct(dialogRes.dialog?.meta);
      if (meta.type === 'dm') {
        res.status(400).json({ error: 'Cannot rename a DM' });
        return;
      }
      const title = String(req.body.title || '').trim();
      if (!title) {
        res.status(400).json({ error: 'title required' });
        return;
      }
      const result = await chat3.updateDialogMeta(req.user!.login, req.params.dialogId, {
        title
      });
      res.json({ dialog: mapDialog(result.dialog) });
    } catch (error: any) {
      console.error('rename-dialog', error);
      res.status(500).json({ error: error?.details || error?.message || 'failed' });
    }
  });

  router.post('/dialogs/:dialogId/messages', authMiddleware, async (req: AuthedRequest, res) => {
    try {
      const content = String(req.body.content || '');
      if (!content.trim()) {
        res.status(400).json({ error: 'content required' });
        return;
      }
      const result = await chat3.sendMessage(req.user!.login, req.params.dialogId, content);
      const m = result.message;
      res.status(201).json({
        message: {
          messageId: m.message_id,
          dialogId: m.dialog_id,
          senderId: m.sender_id,
          content: m.content,
          type: m.type,
          createdAt: m.created_at,
          statuses: (m.statuses || []).map((s: any) => ({
            userId: s.user_id,
            status: s.status,
            createdAt: s.created_at,
            readAt: s.read_at
          }))
        }
      });
    } catch (error: any) {
      console.error('send', error);
      res.status(500).json({ error: error?.details || error?.message || 'failed' });
    }
  });

  return router;
}
