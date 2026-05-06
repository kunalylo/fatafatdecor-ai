// Centralised env-var constants — import from here, never from process.env directly

export const AI_SERVICE_URL   = process.env.AI_SERVICE_URL   || 'http://localhost:8001'
export const IMAGEKIT_URL     = process.env.NEXT_PUBLIC_IMAGEKIT_URL || 'https://ik.imagekit.io/jcp2urr7b'
export const IMAGEKIT_PRIVATE_KEY = process.env.IMAGEKIT_PRIVATE_KEY || ''
export const MONGO_URL        = process.env.MONGO_URL         || ''
export const DB_NAME          = process.env.DB_NAME           || 'fatafatdecor'
export const JWT_SECRET       = process.env.JWT_SECRET        || ''
export const CORS_ORIGINS     = process.env.CORS_ORIGINS      || '*'
export const RAZORPAY_KEY_ID  = process.env.RAZORPAY_KEY_ID  || ''
export const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || ''
export const TWO_FACTOR_API_KEY  = process.env.TWO_FACTOR_API_KEY  || ''
export const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || ''
export const WHATSAPP_ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN    || ''
export const SEED_SECRET      = process.env.SEED_SECRET       || ''
export const RESEND_API_KEY   = process.env.RESEND_API_KEY    || ''

export function getImageKitFolder(budget_min, budget_max) {
  const avg = (Number(budget_min) + Number(budget_max)) / 2
  if (avg <= 5000)  return 'dataset/3k to 5k'
  if (avg <= 10000) return 'dataset/5k to 10k'
  if (avg <= 20000) return 'dataset/20k to 30k'
  if (avg <= 30000) return 'dataset/20k to 30k'
  if (avg <= 50000) return 'dataset/30k to 50k'
  return 'dataset/50,000 and above'
}
