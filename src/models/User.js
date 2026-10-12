import mongoose from 'mongoose';

export const ROLES = Object.freeze({ OWNER: 'OWNER', EMPLOYEE: 'EMPLOYEE' });

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      minlength: 5,
      maxlength: 254,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: Object.values(ROLES), required: true, index: true },
    employeeCode: {
      type: String,
      trim: true,
      uppercase: true,
      minlength: 1,
      maxlength: 32,
      default: undefined,
    },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, versionKey: false },
);

// Unique indexes.
userSchema.index({ email: 1 }, { unique: true });
userSchema.index(
  { employeeCode: 1 },
  {
    unique: true,
    partialFilterExpression: { employeeCode: { $type: 'string' } },
  },
);

// Never leak passwordHash even if a query forgets select:false.
userSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.passwordHash;
    return ret;
  },
});

// Guard against "Cannot overwrite `User` model once compiled" when more than
// one test file (or a hot-reload) imports this module in the same process.
export const User = mongoose.models.User || mongoose.model('User', userSchema);