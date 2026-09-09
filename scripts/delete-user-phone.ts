import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const userSchema = new mongoose.Schema({
  userPhone: { type: String, unique: true },
  userEmail: { type: String, unique: true },
  role: String,
  isActive: Boolean,
}, { collection: 'users' });

const User = mongoose.model('User', userSchema);

async function main() {
  await mongoose.connect(process.env.DATABASE_URL);
  console.log('Connected to MongoDB');

  const phone = '8584091742';
  const result = await User.deleteOne({ userPhone: phone });

  console.log(`Deleted ${result.deletedCount} user(s) with phone ${phone}`);

  // Verify: re-count users with this phone
  const remaining = await User.countDocuments({ userPhone: phone });
  console.log(`Remaining users with phone ${phone}: ${remaining}`);

  await mongoose.disconnect();
  console.log('Done');
}

main().catch(e => { console.error(e); process.exit(1); });