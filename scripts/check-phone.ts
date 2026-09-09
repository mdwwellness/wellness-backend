import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const doctorSchema = new mongoose.Schema({
  name: String,
  email: String,
  phonenumber: String,
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isActive: Boolean,
}, { collection: 'doctors' });

const userSchema = new mongoose.Schema({
  userPhone: { type: String, unique: true },
  userEmail: { type: String, unique: true },
  role: String,
}, { collection: 'users' });

const Doctor = mongoose.model('Doctor', doctorSchema);
const User = mongoose.model('User', userSchema);

async function main() {
  await mongoose.connect(process.env.DATABASE_URL);
  console.log('Connected to MongoDB');

  const phone = '8584091742';

  console.log('Searching Doctor.phonenumber...');
  const doctors = await Doctor.find({ phonenumber: phone }).lean();
  console.log('Doctors found:', doctors.length);
  console.log('Doctors:', JSON.stringify(doctors, null, 2));

  console.log('\nSearching User.userPhone...');
  const users = await User.find({ userPhone: phone }).lean();
  console.log('Users found:', users.length);
  console.log('Users:', JSON.stringify(users, null, 2));

  if (doctors.length > 0) {
    for (const d of doctors) {
      const linkedUser = await User.findById(d.userId).lean();
      console.log('\nLinked User for Doctor:', JSON.stringify(linkedUser, null, 2));
    }
  }

  if (users.length > 0) {
    for (const u of users) {
      const linkedDoctor = await Doctor.findOne({ userId: u._id }).lean();
      console.log('\nLinked Doctor for User:', JSON.stringify(linkedDoctor, null, 2));
    }
  }

  await mongoose.disconnect();
  console.log('\nDone');
}

main().catch(e => { console.error(e); process.exit(1); });