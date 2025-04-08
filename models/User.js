// models/user.js
import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true },
  time: { type: String },
  status: { type: String, default: 'offline' },
  webhookUrl: { type: String },
  userType: { type: String, required: true }   
});

export const User = mongoose.model('User', userSchema);
