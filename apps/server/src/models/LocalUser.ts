import mongoose from 'mongoose';

export interface ILocalUser {
  login: string;
  name: string;
  passwordHash: string;
  createdAt: Date;
}

const localUserSchema = new mongoose.Schema<ILocalUser>({
  login: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

export const LocalUser = mongoose.model<ILocalUser>('LocalUser', localUserSchema);
