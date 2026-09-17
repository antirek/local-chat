import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  jwtSecret: process.env.JWT_SECRET || 'local-chat-dev-secret-change-me',
  mongoUri: process.env.LOCAL_CHAT_MONGO_URI || 'mongodb://127.0.0.1:27027/local_chat',
  chat3: {
    grpcUrl: process.env.CHAT3_GRPC_URL || '127.0.0.1:50051',
    apiKey: process.env.CHAT3_API_KEY || '',
    tenantId: process.env.CHAT3_TENANT_ID || 'tnt_localchat'
  },
  protoPath:
    process.env.CHAT3_PROTO_PATH ||
    path.resolve(__dirname, '../../../vendor/chat3_user.proto')
};
