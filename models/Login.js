// models/user.js
import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  password: { type: String, required: true },
  userType: { type: String, required: true },
  
});

export const Login = mongoose.model('Login', userSchema);
