import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'
import { connectToMongo } from '../db.js'
import { signToken, getUserIdFromRequest } from '../jwt.js'
import { hashPwd, hashOtp, sendOtpSms, asyncRoute } from '../helpers.js'

const router = Router()

// POST /auth/register
router.post('/auth/register', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { name, email, phone, password, role } = req.body
  if (!name || !email || !password) return err('Name, email, password required')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err('Invalid email format')
  if (password.length < 6) return err('Password must be at least 6 characters')
  const existing = await db.collection('users').findOne({ email })
  if (existing) return err('Email already registered')
  const user = {
    id: uuidv4(), name, email, phone: phone || '',
    password: hashPwd(password), role: role || 'user',
    credits: 3, has_purchased_credits: false,
    location: null, city: req.body.city || null,
    auth_provider: 'email', created_at: new Date(),
  }
  await db.collection('users').insertOne(user)
  const { password: _, _id, ...safeUser } = user
  const token = await signToken({ user_id: safeUser.id, role: safeUser.role })
  return ok({ ...safeUser, token })
}))

// POST /auth/send-signup-otp
router.post('/auth/send-signup-otp', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { name, phone } = req.body
  if (!name || !phone) return err('Name and phone number required')
  const cleanCheck = String(phone).replace(/\D/g, '').slice(-10)
  const existingPhone = await db.collection('users').findOne({ phone: { $regex: new RegExp(cleanCheck + '$') } })
  if (existingPhone) return err('This phone number is already registered. Please login instead.')
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000)
  const recentOtp = await db.collection('signup_otps').findOne({ phone })
  if (recentOtp && recentOtp.otp_count >= 3 && new Date(recentOtp.updated_at) > tenMinAgo)
    return err('Too many OTP requests. Please wait 10 minutes before trying again.', 429)
  const otp       = String(Math.floor(100000 + Math.random() * 900000))
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
  await db.collection('signup_otps').updateOne(
    { phone },
    { $set: { phone, name, otp_hash: hashOtp(otp), expires_at: expiresAt, updated_at: new Date() }, $inc: { otp_count: 1 }, $setOnInsert: { created_at: new Date() } },
    { upsert: true }
  )
  if (process.env.TWO_FACTOR_API_KEY) {
    const sent = await sendOtpSms(phone, otp)
    if (!sent) return err('Failed to send OTP. Please check your number and try again.', 503)
    return ok({ message: 'OTP sent to your phone' })
  }
  console.log(`[Dev] Signup OTP for ${phone}: ${otp}`)
  return ok({ message: 'OTP generated (dev mode)', dev_otp: otp })
}))

// POST /auth/verify-signup-otp
router.post('/auth/verify-signup-otp', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { phone, otp, name, email, password, firebase_verified } = req.body
  if (!phone || !email || !password) return err('Phone, email, and password required')
  let otpDoc = null
  if (!firebase_verified) {
    if (!otp) return err('OTP required')
    otpDoc = await db.collection('signup_otps').findOne({ phone })
    if (!otpDoc) return err('Please request OTP first', 404)
    if (new Date(otpDoc.expires_at).getTime() < Date.now()) {
      await db.collection('signup_otps').deleteOne({ phone })
      return err('OTP expired. Please request a new OTP', 410)
    }
    const expected = Buffer.from(hashOtp(otp), 'hex')
    const actual   = Buffer.from(otpDoc.otp_hash, 'hex')
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual))
      return err('Invalid OTP', 401)
  }
  const existing = await db.collection('users').findOne({ email })
  if (existing) return err('Email already registered')
  const user = {
    id: uuidv4(), name: name || otpDoc?.name || 'User', email, phone,
    password: hashPwd(password), role: 'user',
    credits: 3, has_purchased_credits: false,
    location: null, city: null, auth_provider: 'email', created_at: new Date(),
  }
  await db.collection('users').insertOne(user)
  await db.collection('signup_otps').deleteOne({ phone })
  const { password: _, _id, ...safeUser } = user
  const token = await signToken({ user_id: safeUser.id, role: safeUser.role })
  return ok({ ...safeUser, token })
}))

// POST /auth/login
router.post('/auth/login', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { email, password } = req.body
  if (!email || !password) return err('Email and password required')
  const fifteenMinAgo  = new Date(Date.now() - 15 * 60 * 1000)
  const loginAttempts  = await db.collection('login_attempts').findOne({ email })
  if (loginAttempts && loginAttempts.count >= 10 && new Date(loginAttempts.updated_at) > fifteenMinAgo)
    return err('Too many login attempts. Please wait 15 minutes.', 429)
  const user = await db.collection('users').findOne({ email, password: hashPwd(password) })
  if (!user) {
    await db.collection('login_attempts').updateOne(
      { email },
      { $inc: { count: 1 }, $set: { updated_at: new Date() }, $setOnInsert: { created_at: new Date() } },
      { upsert: true }
    )
    return err('Invalid credentials', 401)
  }
  await db.collection('login_attempts').deleteOne({ email })
  const { password: _, _id, ...safeUser } = user
  const token = await signToken({ user_id: safeUser.id, role: safeUser.role })
  return ok({ ...safeUser, token })
}))

// POST /auth/send-login-otp
router.post('/auth/send-login-otp', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { phone } = req.body
  if (!phone) return err('Phone number required')
  const clean = phone.replace(/\D/g, '').slice(-10)
  const user  = await db.collection('users').findOne({ phone: { $regex: new RegExp(clean + '$') } })
  if (!user) return err('No account found with this phone number', 404)
  const otp       = String(Math.floor(100000 + Math.random() * 900000))
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
  await db.collection('login_otps').updateOne(
    { phone: clean },
    { $set: { phone: clean, otp_hash: hashOtp(otp), expires_at: expiresAt, updated_at: new Date() }, $setOnInsert: { created_at: new Date() } },
    { upsert: true }
  )
  if (process.env.TWO_FACTOR_API_KEY) {
    const sent = await sendOtpSms(clean, otp)
    if (!sent) return err('Failed to send OTP. Please check your number and try again.', 503)
    return ok({ message: 'OTP sent to your phone' })
  }
  return ok({ message: 'OTP generated (dev mode)', dev_otp: otp })
}))

// POST /auth/verify-login-otp
router.post('/auth/verify-login-otp', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { phone, otp } = req.body
  if (!phone || !otp) return err('Phone and OTP required')
  const clean  = phone.replace(/\D/g, '').slice(-10)
  const otpDoc = await db.collection('login_otps').findOne({ phone: clean })
  if (!otpDoc) return err('Please request OTP first', 404)
  if (new Date(otpDoc.expires_at).getTime() < Date.now()) {
    await db.collection('login_otps').deleteOne({ phone: clean })
    return err('OTP expired. Please request a new OTP', 410)
  }
  const expected = Buffer.from(hashOtp(otp), 'hex')
  const actual   = Buffer.from(otpDoc.otp_hash, 'hex')
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual))
    return err('Invalid OTP', 401)
  await db.collection('login_otps').deleteOne({ phone: clean })
  const user = await db.collection('users').findOne({ phone: { $regex: new RegExp(clean + '$') } })
  if (!user) return err('User not found', 404)
  const { password: _, _id, ...safeUser } = user
  const token = await signToken({ user_id: safeUser.id, role: safeUser.role })
  return ok({ ...safeUser, token })
}))

// POST /auth/forgot-otp
router.post('/auth/forgot-otp', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { identifier } = req.body
  if (!identifier) return err('Email or phone number required')
  let user
  if (identifier.includes('@')) {
    user = await db.collection('users').findOne({ email: identifier.toLowerCase().trim() })
  } else {
    const clean = identifier.replace(/\D/g, '').slice(-10)
    user = await db.collection('users').findOne({ phone: { $regex: new RegExp(clean + '$') } })
  }
  if (!user) return err('No account found with this email or phone', 404)
  if (!user.phone) return err('No phone number linked to this account. Please contact support.', 400)
  const clean     = user.phone.replace(/\D/g, '').slice(-10)
  const otp       = String(Math.floor(100000 + Math.random() * 900000))
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
  await db.collection('forgot_otps').updateOne(
    { phone: clean },
    { $set: { phone: clean, otp_hash: hashOtp(otp), expires_at: expiresAt, updated_at: new Date() }, $setOnInsert: { created_at: new Date() } },
    { upsert: true }
  )
  if (process.env.TWO_FACTOR_API_KEY) {
    const sent = await sendOtpSms(clean, otp)
    if (!sent) return err('Failed to send OTP. Please check your number.', 503)
    return ok({ message: 'OTP sent', phone: clean })
  }
  return ok({ message: 'OTP generated (dev mode)', dev_otp: otp, phone: clean })
}))

// POST /auth/reset-password
router.post('/auth/reset-password', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { phone, otp, new_password } = req.body
  if (!phone || !otp || !new_password) return err('Phone, OTP and new password required')
  if (new_password.length < 6) return err('Password must be at least 6 characters')
  const clean  = phone.replace(/\D/g, '').slice(-10)
  const otpDoc = await db.collection('forgot_otps').findOne({ phone: clean })
  if (!otpDoc) return err('Please request OTP first', 404)
  if (new Date(otpDoc.expires_at).getTime() < Date.now()) {
    await db.collection('forgot_otps').deleteOne({ phone: clean })
    return err('OTP expired. Please request a new one.', 410)
  }
  const expected = Buffer.from(hashOtp(otp), 'hex')
  const actual   = Buffer.from(otpDoc.otp_hash, 'hex')
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual))
    return err('Invalid OTP', 401)
  await db.collection('forgot_otps').deleteOne({ phone: clean })
  const result = await db.collection('users').updateOne(
    { phone: { $regex: new RegExp(clean + '$') } },
    { $set: { password: hashPwd(new_password), updated_at: new Date() } }
  )
  if (!result.matchedCount) return err('User not found', 404)
  return ok({ success: true, message: 'Password reset successfully! Please login.' })
}))

// POST /auth/google
router.post('/auth/google', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { google_id, email, name, photo_url, city } = req.body
  if (!google_id || !email) return err('google_id and email required')
  let user = await db.collection('users').findOne({ $or: [{ google_id }, { email }] })
  if (!user) {
    user = {
      id: uuidv4(), name: name || email.split('@')[0], email,
      phone: '', password: null, role: 'user',
      credits: 3, has_purchased_credits: false,
      location: null, city: city || null,
      google_id, photo_url: photo_url || null,
      auth_provider: 'google', created_at: new Date(),
    }
    await db.collection('users').insertOne(user)
  } else if (!user.google_id) {
    await db.collection('users').updateOne({ id: user.id }, { $set: { google_id, photo_url, auth_provider: 'google' } })
    user = { ...user, google_id, photo_url }
  }
  const { password: _, _id, ...safeUser } = user
  const token = await signToken({ user_id: safeUser.id, role: safeUser.role })
  return ok({ ...safeUser, token })
}))

// POST /auth/delete-account
router.post('/auth/delete-account', asyncRoute(async (req, res, ok, err) => {
  const db = await connectToMongo()
  const { email, password } = req.body
  if (!email || !password) return err('Email and password required')
  const user = await db.collection('users').findOne({ email, password: hashPwd(password) })
  if (!user) return err('Invalid email or password', 401)
  await db.collection('users').deleteOne({ id: user.id })
  await db.collection('orders').deleteMany({ user_id: user.id })
  await db.collection('designs').deleteMany({ user_id: user.id })
  const clean = user.phone?.replace(/\D/g, '').slice(-10)
  if (clean) {
    await db.collection('signup_otps').deleteMany({ phone: { $in: [user.phone, clean] } })
    await db.collection('login_otps').deleteMany({ phone: { $in: [user.phone, clean] } })
  }
  return ok({ success: true, message: 'Account deleted successfully' })
}))

export default router
