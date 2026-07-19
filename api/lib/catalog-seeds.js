/**
 * catalog-seeds.js — DEFAULT seed data for the gifts/bulk/corporate/private/festivals catalogs.
 *
 * These arrays are the factory defaults for their MongoDB collections. They are
 * lazily inserted ONLY when a collection is found empty (first boot / fresh DB).
 * After that, the documents in Mongo are the source of truth — admin edits
 * (rename, reprice, hide via active:false, reorder via sortOrder, new images)
 * live in the DB and are never overwritten by these seeds.
 *
 * Copy rules applied throughout (per developer brief): "Setup" not "Delivery",
 * "Book Again" not "Reorder", Ranchi/Jharkhand (never Mumbai), no emojis.
 * Images point at ImageKit CDN URLs (real content-pack assets) where a real
 * photo exists; remaining slots keep the prototype Unsplash placeholders.
 *
 * Festival dates: stored as { month (1-12), day } and rolled forward to the
 * next occurrence at request time. Lunar-calendar festivals (Eid, Diwali,
 * Holi, Rakhi) shift every year — these are admin-editable approximations.
 */

const IK = 'https://ik.imagekit.io/jcp2urr7b/content';

// ---------------------------------------------------------------------------
// FESTIVALS (7) — landing pages at /festival/:id, home carousel uses featured
// ---------------------------------------------------------------------------
export const SEED_FESTIVALS = [
  {
    id: 'diwali',
    name: 'Diwali',
    tagline: 'Festival of lights',
    month: 10,
    day: 21,
    accent: 'accent-peach',
    color: '#FFB088',
    eyebrow: 'Roshni Collection',
    description: 'Hand-picked diyas, mithai boxes and gilded hampers — curated for those who matter most.',
    hero: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/diwali/hero_diwali_LOw-MlbUm.jpg`,
    featured: true,
    sortOrder: 0,
    active: true,
    hampers: [
      { id: 'd1', name: 'Roshni Signature Box', price: 2999, image: `${IK}/02_home_page/04_festival_hampers/festival_hampers_diwali_roshni_collection_XoDXGLNtk.jpg`, category: 'Premium' },
      { id: 'd2', name: 'Gilded Diya & Sweets', price: 1899, image: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/diwali/golden_diya_and_sweets_WX9Hd_6Cp.jpg`, category: 'Classic' },
      { id: 'd3', name: 'Heritage Mithai Hamper', price: 2499, image: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/diwali/heritage_mithai_hamper_qZGGOXL0w.jpg`, category: 'Sweets' },
      { id: 'd4', name: 'Lakshmi Worship Set', price: 1599, image: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/diwali/lakshmi_worship_set_Vnd5UUOnz.jpg`, category: 'Pooja' },
    ],
  },
  {
    id: 'holi',
    name: 'Holi',
    tagline: 'Colours of joy',
    month: 3,
    day: 14,
    accent: 'accent-pink',
    color: '#FF8AB0',
    eyebrow: 'Rang Collection',
    description: 'Organic gulaal, thandai concentrate and edible colours — a Holi hamper worth gifting.',
    hero: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/holi/hero_holi_cnQbFlpl-.jpg`,
    featured: true,
    sortOrder: 1,
    active: true,
    hampers: [
      { id: 'h1', name: 'Rang Premium Box', price: 1799, image: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/holi/rang_premium_box_fntF0a5f7.jpg`, category: 'Premium' },
      { id: 'h2', name: 'Organic Gulaal Set', price: 999, image: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/holi/organic_gulaal_set_a-O83PM-9.jpg`, category: 'Classic' },
      { id: 'h3', name: 'Thandai & Sweets', price: 1299, image: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/holi/thandai_and_sweets_hABfBSjBK.jpg`, category: 'Drinks' },
    ],
  },
  {
    id: 'rakhi',
    name: 'Rakhi',
    tagline: 'For your sibling',
    month: 8,
    day: 9,
    accent: 'accent-lavender',
    color: '#B89AFF',
    eyebrow: 'Bandhan Collection',
    description: 'Designer rakhis paired with chocolates, dry fruits and personalised cards.',
    hero: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/rakhi/hero_rakhi_dM565YyG_.jpg`,
    featured: true,
    sortOrder: 2,
    active: true,
    hampers: [
      { id: 'r1', name: 'Bandhan Signature', price: 1499, image: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/rakhi/bandhan_signature_fzucfs4Vg.jpg`, category: 'Premium' },
      { id: 'r2', name: 'Rakhi & Chocolates', price: 899, image: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/rakhi/rakhi_and_chocolates_Rjm_BDYKO.jpg`, category: 'Classic' },
      { id: 'r3', name: 'Dry Fruits Hamper', price: 1299, image: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/rakhi/dry_fruits_hamper_fU-n3Sp5N.jpg`, category: 'Healthy' },
    ],
  },
  {
    id: 'christmas',
    name: 'Christmas',
    tagline: 'Merry & bright',
    month: 12,
    day: 25,
    accent: 'accent-mint',
    color: '#88E0AA',
    eyebrow: 'Noel Collection',
    description: 'Cinnamon-scented candles, plum cake and stockings filled with little surprises.',
    hero: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/christmas/christmas_hero_kv6q4jSnn.jpg`,
    featured: true,
    sortOrder: 3,
    active: true,
    hampers: [
      { id: 'c1', name: 'Noel Signature Hamper', price: 2299, image: `${IK}/02_home_page/04_festival_hampers/festival_hampers_christmas_collection_GM4Xeugha.jpg`, category: 'Premium' },
      { id: 'c2', name: 'Plum Cake & Wine', price: 1799, image: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/christmas/plum_cake_and_wine_-Zoe6hoTo.jpg`, category: 'Edible' },
      { id: 'c3', name: 'Stocking Surprise', price: 999, image: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/christmas/stocking_surprise_h8W4mwlOT.jpg`, category: 'Classic' },
    ],
  },
  {
    // Eid follows the lunar calendar — prototype date was invalid ("April 31").
    // Approximate next occurrence (Eid al-Adha 2026); edit in admin each year.
    id: 'eid',
    name: 'Eid',
    tagline: 'Eid Mubarak',
    month: 6,
    day: 26,
    accent: 'accent-mint',
    color: '#88E0AA',
    eyebrow: 'Noor Collection',
    description: 'Crafted dates, baklava, and silver-foiled mithai — for the warmest greetings.',
    hero: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/eid/eid_hero_FeP1iNBQD.jpg`,
    featured: false,
    sortOrder: 4,
    active: true,
    hampers: [
      { id: 'e1', name: 'Noor Premium Box', price: 2199, image: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/eid/noor_premium_box_iLmsxgAb_.jpg`, category: 'Premium' },
      { id: 'e2', name: 'Dates & Baklava', price: 1499, image: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/eid/dates_and_bakava_U0lUBLGPQ.jpg`, category: 'Classic' },
    ],
  },
  {
    id: 'valentine',
    name: "Valentine's",
    tagline: 'For your one & only',
    month: 2,
    day: 14,
    accent: 'accent-pink',
    color: '#FF8AB0',
    eyebrow: 'Amour Collection',
    description: 'Roses, chocolates and personalised love notes — a hamper as romantic as the day.',
    hero: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/valentines/hero_a9Mslcnwo.jpg`,
    featured: false,
    sortOrder: 5,
    active: true,
    hampers: [
      { id: 'v1', name: 'Amour Luxury Box', price: 2499, image: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/valentines/amour_luxury_box_Jt6d1eat0.jpg`, category: 'Premium' },
      { id: 'v2', name: 'Rose & Chocolate Bubble', price: 1299, image: `${IK}/02_home_page/04_festival_hampers/hero_and_product_image/valentines/rose_and_chocolate_bubble__cS0-8ir5.jpg`, category: 'Classic' },
    ],
  },
  {
    id: 'newyear',
    name: 'New Year',
    tagline: 'Welcome the new',
    month: 12,
    day: 31,
    accent: 'accent-lavender',
    color: '#B89AFF',
    eyebrow: 'Renaissance Collection',
    description: 'Champagne, gold confetti and a planner for the year to come.',
    hero: 'https://images.unsplash.com/photo-1542843137-8791a6904d14?w=1200&q=85',
    featured: false,
    sortOrder: 6,
    active: true,
    hampers: [
      { id: 'n1', name: 'Renaissance Hamper', price: 2799, image: 'https://images.unsplash.com/photo-1542843137-8791a6904d14?w=600&q=85', category: 'Premium' },
      { id: 'n2', name: 'Bubbly & Confetti', price: 1899, image: 'https://images.unsplash.com/photo-1481391319762-47dff72954d9?w=600&q=85', category: 'Classic' },
    ],
  },
];

// ---------------------------------------------------------------------------
// GIFT CATEGORIES (7) — "Browse by category" rail on the Gifts tab
// ---------------------------------------------------------------------------
export const SEED_GIFT_CATEGORIES = [
  { id: 'birthday', name: 'Birthday Gifts', image: `${IK}/03_gifts_shop/02_browse_by_category/birthday_gifts_Fo79uT9w9.jpg`, accent: 'accent-peach', sortOrder: 0, active: true },
  { id: 'baby-shower', name: 'Baby Shower Gifts', image: `${IK}/03_gifts_shop/02_browse_by_category/baby_shower_gifts_78DP3EZvh.jpg`, accent: 'accent-lavender', sortOrder: 1, active: true },
  { id: 'anniversary', name: 'Anniversary Gifts', image: `${IK}/03_gifts_shop/02_browse_by_category/happy_anniversary_gifts_4K8nn4t-b.jpg`, accent: 'accent-pink', sortOrder: 2, active: true },
  { id: 'return', name: 'Return Gifts', image: `${IK}/03_gifts_shop/02_browse_by_category/return_gifts_4QCIbneFJ.jpg`, accent: 'accent-mint', sortOrder: 3, active: true },
  { id: 'corporate', name: 'Corporate Hampers', image: `${IK}/03_gifts_shop/02_browse_by_category/corporate_gifts_DU873RESn.jpg`, accent: 'accent-mint', sortOrder: 4, active: true },
  { id: 'festival', name: 'Festival Hampers', image: `${IK}/03_gifts_shop/02_browse_by_category/festival_hampers_VYsCnbFh6.jpg`, accent: 'accent-peach', sortOrder: 5, active: true },
  { id: 'balloon', name: 'Custom Balloon Gifts', image: `${IK}/03_gifts_shop/02_browse_by_category/custome_balloons_rRTPUqf8o.jpg`, accent: 'accent-pink', sortOrder: 6, active: true },
];

// ---------------------------------------------------------------------------
// SHOP GIFTS (6) — "ALL GIFTS / Shop Gifts" product grid on the Gifts tab
// ---------------------------------------------------------------------------
export const SEED_SHOP_GIFTS = [
  { id: 'gp1', title: 'Pastel Balloon Bouquet', price: 599, minQty: 1, image: `${IK}/03_gifts_shop/shop_all_gifts/pastel_ballon_bantique_OBWKYWz2A.jpg`, delivery: 'same-day', customizable: true, tag: 'Bestseller', sortOrder: 0, active: true },
  { id: 'gp2', title: 'Baby Shower Hamper', price: 1499, minQty: 1, image: `${IK}/03_gifts_shop/shop_all_gifts/pastel_baby_gift_hamper_arrangement__pGS8kGFt.jpg`, delivery: 'next-day', customizable: true, sortOrder: 1, active: true },
  { id: 'gp3', title: 'Corporate Welcome Kit', price: 1299, minQty: 10, image: `${IK}/03_gifts_shop/shop_all_gifts/corporate_welecome_kit_nl9NuY8o1.jpg`, delivery: 'next-day', customizable: true, sortOrder: 2, active: true },
  { id: 'gp4', title: 'Anniversary Rose Box', price: 999, minQty: 1, image: `${IK}/03_gifts_shop/shop_all_gifts/luxurious_rose_arrangement_in_elegant_box_uIk4_BlTK.jpg`, delivery: 'same-day', customizable: false, sortOrder: 3, active: true },
  { id: 'gp5', title: 'Diwali Mithai Hamper', price: 1899, minQty: 1, image: `${IK}/03_gifts_shop/shop_all_gifts/diwali_mithai_hamper_BfSFWLreM.jpg`, delivery: 'next-day', customizable: true, sortOrder: 4, active: true },
  // Title per Harshal CSV override (prototype called it 'Birthday Return Mug')
  { id: 'gp6', title: 'Birthday Return Gifts / Custom Birthday Mugs', price: 249, minQty: 20, image: `${IK}/03_gifts_shop/shop_all_gifts/birthday_return_gift_QvR8EoYA4.jpg`, delivery: 'next-day', customizable: true, sortOrder: 5, active: true },
];

// ---------------------------------------------------------------------------
// BULK — occasion cards, theme chips, pricing tiers, curated hampers
// ---------------------------------------------------------------------------
export const SEED_BULK_OCCASIONS = [
  { id: 'birthday-return', name: 'Birthday Return Gifts', icon: 'Cake', desc: 'For 10–100 guests', image: 'https://images.unsplash.com/photo-1513885535751-8b9238bd345a?w=600&q=85', accent: 'accent-peach', sortOrder: 0, active: true },
  { id: 'baby-shower', name: 'Baby Shower Bulk Gifts', icon: 'Baby', desc: 'Pastel · soft · adorable', image: 'https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=600&q=85', accent: 'accent-lavender', sortOrder: 1, active: true },
  { id: 'corporate', name: 'Corporate Hampers', icon: 'Briefcase', desc: 'GST + branded boxes', image: 'https://images.unsplash.com/photo-1556761175-5973dc0f32e7?w=600&q=85', accent: 'accent-mint', sortOrder: 2, active: true },
  { id: 'school', name: 'School / Kids Gifts', icon: 'GraduationCap', desc: 'Goodie bags + class hampers', image: 'https://images.unsplash.com/photo-1481391319762-47dff72954d9?w=600&q=85', accent: 'accent-pink', sortOrder: 3, active: true },
  { id: 'festival', name: 'Festival Hampers', icon: 'Flame', desc: 'Diwali · Holi · Rakhi · Eid', image: 'https://ik.imagekit.io/jcp2urr7b/content/02_home_page/04_festival_hampers/festival_hampers_diwali_roshni_collection_XoDXGLNtk.jpg', accent: 'accent-peach', sortOrder: 4, active: true },
];

export const SEED_BULK_THEMES = [
  { id: 'pastel', name: 'Pastel' },
  { id: 'royal', name: 'Royal' },
  { id: 'minimal', name: 'Minimal' },
  { id: 'festive', name: 'Festive' },
  { id: 'corporate', name: 'Corporate' },
  { id: 'kids', name: 'Kids' },
];

export const SEED_BULK_TIERS = [
  { id: 't1', qty: '10–24', perUnit: 1199, save: 0, label: 'Starter', sortOrder: 0, active: true },
  { id: 't2', qty: '25–49', perUnit: 999, save: 17, label: 'Growth', sortOrder: 1, active: true },
  { id: 't3', qty: '50–99', perUnit: 849, save: 29, label: 'Pro', sortOrder: 2, active: true },
  { id: 't4', qty: '100+', perUnit: 699, save: 42, label: 'Scale', sortOrder: 3, active: true },
];

export const SEED_BULK_HAMPERS = [
  { id: 'b1', name: 'Wellness Curated Box', perUnit: 999, image: 'https://images.unsplash.com/photo-1599490659213-e2b9527bd087?w=600&q=85', category: 'Wellness', contents: ['Organic tea', 'Dark chocolate', 'Scented candle', 'Journal'], sortOrder: 0, active: true },
  { id: 'b2', name: 'Festive Gold Hamper', perUnit: 1499, image: 'https://ik.imagekit.io/jcp2urr7b/content/02_home_page/04_festival_hampers/hero_and_product_image/diwali/golden_diya_and_sweets_WX9Hd_6Cp.jpg', category: 'Festive', contents: ['Dry fruits', 'Mithai box', 'Diya set', 'Greeting card'], sortOrder: 1, active: true },
  { id: 'b3', name: 'Gourmet Snack Trove', perUnit: 849, image: 'https://images.unsplash.com/photo-1571167530149-c1105da4c2c7?w=600&q=85', category: 'Edible', contents: ['Artisan snacks', 'Cold brew', 'Macarons', 'Note'], sortOrder: 2, active: true },
  { id: 'b4', name: 'Eco Plantable Box', perUnit: 699, image: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=600&q=85', category: 'Sustainable', contents: ['Plantable pen', 'Seed paper card', 'Bamboo bottle', 'Cotton tote'], sortOrder: 3, active: true },
];

// ---------------------------------------------------------------------------
// CORPORATE DESK — packages, hampers, add-ons
// ---------------------------------------------------------------------------
export const SEED_CORPORATE_PACKAGES = [
  { id: 'starter', name: 'Starter Corporate Box', range: '₹499–₹899', desc: 'For new hires & quick gifts', accent: 'accent-mint', popular: false, sortOrder: 0, active: true },
  { id: 'premium', name: 'Premium Corporate Box', range: '₹1,000–₹1,999', desc: 'For client appreciation', accent: 'accent-peach', popular: true, sortOrder: 1, active: true },
  { id: 'luxe', name: 'Luxe Corporate Box', range: '₹2,500–₹4,999', desc: 'For board & investors', accent: 'accent-lavender', popular: false, sortOrder: 2, active: true },
  { id: 'bespoke', name: 'Bespoke Corporate Box', range: 'Custom', desc: 'Fully custom · co-branded', accent: 'accent-pink', popular: false, sortOrder: 3, active: true },
];

export const SEED_CORPORATE_HAMPERS = [
  { id: 'c1', name: 'Onboarding Welcome Kit', perUnit: 1299, image: 'https://images.unsplash.com/photo-1556761175-5973dc0f32e7?w=600&q=85', use: 'New hires', contents: ['Branded notebook', 'Premium pen', 'Bottle', 'Welcome card'], sortOrder: 0, active: true },
  { id: 'c2', name: 'Client Diwali Hamper', perUnit: 2499, image: 'https://ik.imagekit.io/jcp2urr7b/content/02_home_page/04_festival_hampers/hero_and_product_image/diwali/heritage_mithai_hamper_qZGGOXL0w.jpg', use: 'Top accounts', contents: ['Premium dry fruits', 'Gilded diya', 'Personalised letter', 'Silk pouch'], sortOrder: 1, active: true },
  { id: 'c3', name: 'Team Appreciation Box', perUnit: 999, image: 'https://images.unsplash.com/photo-1513885535751-8b9238bd345a?w=600&q=85', use: 'Quarterly awards', contents: ['Custom trophy', 'Chocolates', 'Co-branded tote', 'Thank-you card'], sortOrder: 2, active: true },
  { id: 'c4', name: 'Investor Premium Hamper', perUnit: 4999, image: 'https://customer-assets.emergentagent.com/job_premium-decor-design-2/artifacts/kuxwbqy4_IMG_2309.JPG', use: 'Board & investors', contents: ['Single malt', 'Crystal glassware', 'Cigar set', 'Leather journal'], sortOrder: 3, active: true },
];

export const SEED_CORPORATE_ADDONS = [
  { id: 'logo', label: 'Co-branded packaging', price: 49 },
  { id: 'card', label: 'Custom message card', price: 19 },
  { id: 'gst', label: 'GST invoice', price: 0, free: true },
  { id: 'pan', label: 'Pan-India delivery', price: 0, free: true },
  { id: 'mgr', label: 'Dedicated account manager', price: 0, free: true },
];

// ---------------------------------------------------------------------------
// PRIVATE COLLECTION (Velvet) — types, gated items, perks, invite codes
// ---------------------------------------------------------------------------
export const SEED_PRIVATE_TYPES = [
  { id: 'baby', name: 'Baby Shower Premium Boxes', icon: 'Baby', tint: 'rgba(184,154,255,0.18)', sortOrder: 0 },
  { id: 'corporate', name: 'Corporate Luxe Hampers', icon: 'Briefcase', tint: 'rgba(229,197,137,0.18)', sortOrder: 1 },
  { id: 'festival', name: 'Festival Signature Hampers', icon: 'Flame', tint: 'rgba(255,176,136,0.18)', sortOrder: 2 },
  { id: 'wedding', name: 'Wedding / Engagement', icon: 'Heart', tint: 'rgba(255,136,180,0.18)', sortOrder: 3 },
  { id: 'balloon', name: 'Custom Balloon Sets', icon: 'Wand2', tint: 'rgba(180,232,200,0.18)', sortOrder: 4 },
  { id: 'invitation', name: 'Premium Invitation Kits', icon: 'MailOpen', tint: 'rgba(255,200,220,0.18)', sortOrder: 5 },
];

// NOTE: prices are "vault pricing" — never expose to locked (non-member) users.
export const SEED_VELVET_ITEMS = [
  { id: 'p1', name: 'Maison Champagne Soirée', price: 18999, image: 'https://images.unsplash.com/photo-1519225421980-715cb0215aed?w=900&q=85', edition: 'Private edition · 12 of 50', desc: 'A privately-curated dinner setup with crystal stemware, white roses, and a sommelier-selected magnum.', active: true },
  { id: 'p2', name: 'Onyx Anniversary Suite', price: 24999, image: 'https://images.unsplash.com/photo-1519741497674-611481863552?w=900&q=85', edition: 'Private edition · 4 of 25', desc: 'A blacked-out floral ceiling, candlelit terrace and a personalised letter — only for the most romantic.', active: true },
  { id: 'p3', name: 'Sienna Sunset Proposal', price: 32999, image: 'https://images.unsplash.com/photo-1530103862676-de8c9debad1d?w=900&q=85', edition: 'Private edition · 6 of 20', desc: 'A rooftop with terracotta blooms, hand-thrown ceramics and a violinist for the moment.', active: true },
  { id: 'p4', name: 'Ivory Wedding Atelier', price: 49999, image: 'https://customer-assets.emergentagent.com/job_premium-decor-design-2/artifacts/kuxwbqy4_IMG_2309.JPG', edition: 'Private edition · 2 of 10', desc: 'An ivory mandap, hand-embroidered drapes, and an exclusive perfumer for personalised aroma.', active: true },
];

export const SEED_VELVET_PERKS = [
  'Hand-delivered by senior designer',
  'Concierge: WhatsApp 24/7',
  'Trial-setup at your venue',
  'Vault pricing (off-catalogue)',
  'Invite to bi-annual atelier preview',
];

// Server-side invite-code validation only — never ship these to the client.
export const SEED_VELVET_CODES = [
  { code: 'AANYA2025', active: true },
  { code: 'VELVET', active: true },
  { code: 'INVITE', active: true },
];

// ---------------------------------------------------------------------------
// OFFERS — declarative promo rules (replaces the prototype's compute() fns)
// ---------------------------------------------------------------------------
export const SEED_OFFERS = [
  { code: 'FIRST50', label: '50% off first order, up to ₹200', detail: 'New customers only. Maximum discount of ₹200.', discountType: 'percent', value: 50, maxDiscount: 200, newCustomerOnly: true, accent: 'accent-pink', active: true },
  { code: 'AANYA250', label: 'Flat ₹250 off · referral code', detail: 'Welcome bonus from a friend’s referral.', discountType: 'flat', value: 250, accent: 'accent-lavender', active: true },
  { code: 'LOVE100', label: 'Flat ₹100 off everything', detail: 'No minimum. Works across gifts, decor, and AI bundles.', discountType: 'flat', value: 100, accent: 'accent-peach', active: true },
];

// ---------------------------------------------------------------------------
// LEAD STATUSES — workflow for gift/bulk/corporate/private enquiries
// ---------------------------------------------------------------------------
export const SEED_LEAD_STATUSES = [
  { id: 'callback-pending', label: 'Callback pending', tone: 'amber' },
  { id: 'quote-shared', label: 'Quote shared', tone: 'pink' },
  { id: 'confirmed', label: 'Confirmed', tone: 'green' },
];
