import type { ContentTypeDefinition, ObjectDefinition } from '../../sdk/src/definitions'

/**
 * Content-model templates (M11 / PRD-v2 §3.4).
 *
 * WHY THESE EXIST AT ALL
 * ----------------------
 * §8 froze the content model on the reasoning that "otherwise the agent invents
 * schemas". Opening the model in M11 puts that risk back, and the additive-only
 * rule only softens it — it makes a bad schema survivable, not less likely.
 *
 * Templates are the other half of the answer, and they work on the axis that
 * matters: they make defining from scratch the ADVANCED path rather than the
 * first one. An agent that starts from `hospitality` gets a model somebody
 * thought about; an agent that starts from an empty project gets whatever it
 * guessed at 2am.
 *
 * They are also the distribution argument. Sanity starts everyone on a blank
 * page. A guest house that runs one command and has a working content model is
 * the difference between a product and a toolkit.
 *
 * WHY THEY LIVE IN THE CLI AND NOT THE API
 * ----------------------------------------
 * A template is just a sequence of `POST /v1/objects` and `POST /v1/types` — it
 * needs no server support, and putting it here means it ships and changes with
 * the tool the agent already has, rather than requiring a deploy. It also keeps
 * the API honest: there is no privileged path that creates a model, only the one
 * every caller uses.
 *
 * TITLES ARE HEBREW, KEYS ARE NOT. The title is what the studio shows a business
 * owner (§13: no jargon, in Hebrew). The key becomes a TypeScript property name
 * and a URL segment.
 */

export interface ContentTemplate {
  readonly name: string
  /** One line, shown by `templates list`. */
  readonly description: string
  readonly objects: readonly ObjectDefinition[]
  readonly types: readonly ContentTypeDefinition[]
}

/* ── shared field shorthands ──────────────────────────────────────────────── */

/* ── sidebar groups (M15 / PRD-v2 §6.2) ───────────────────────────────────── */

/**
 * The headings the studio files these types under.
 *
 * IN BUSINESS LANGUAGE, NOT IN OURS. §6.2's whole argument is that a business
 * owner does not know what a "content type" is but knows exactly what "המחירים
 * שלי" means. A template is where that translation belongs, because it is the
 * one place that knows a `stayRule` is a pricing rule rather than an article.
 *
 * Constants rather than inline strings so a heading is spelled one way. Two
 * spellings of the same group produce two groups in the sidebar, which reads as
 * a bug and is invisible in review.
 *
 * NOT "הגדרות", WHICH IS ALREADY TAKEN. The studio's own settings section — API
 * keys, the plan, the connection — sits in the sidebar under that exact word, so
 * a content group called the same thing put two identical labels in one
 * navigation meaning two different things. Caught in a browser, not by a test.
 * "פרטי העסק" is also the truer name: what `siteSettings` actually holds in
 * every template is a phone number, an address, a logo and a menu, and §13 does
 * not want a business owner reading "settings" to change their phone number.
 */
const SETTINGS_GROUP = 'פרטי העסק'

const TITLE = { name: 'title', title: 'כותרת', kind: 'string', required: true } as const
const SLUG = { name: 'slug', title: 'כתובת בעמוד', kind: 'string', required: true } as const
const SEO = { name: 'seo', title: 'SEO', kind: 'seo', required: false } as const
const ORDER = { name: 'order', title: 'סדר', kind: 'number', required: false } as const

/* ── shared objects ───────────────────────────────────────────────────────── */

/**
 * `galleryImage` and `faq` are ALREADY seeded into every project (see the SDK's
 * `OBJECT_LIST`), so no template redefines them — `apply` would get a 409 and
 * the operator would be told a shape "already exists" for something they never
 * created. Templates only add what is missing.
 */
const PRICE_ROW: ObjectDefinition = {
  key: 'priceRow',
  title: 'שורת מחירון',
  fields: [
    { name: 'label', title: 'תווית', kind: 'string', required: true },
    { name: 'price', title: 'מחיר', kind: 'number', required: true },
    { name: 'suffix', title: 'סיומת', kind: 'string', required: false },
    { name: 'note', title: 'הערה', kind: 'text', required: false },
  ],
}

const NAVIGATION_ITEM: ObjectDefinition = {
  key: 'navigationItem',
  title: 'פריט ניווט',
  fields: [
    { name: 'label', title: 'תווית', kind: 'string', required: true },
    { name: 'url', title: 'קישור', kind: 'url', required: true },
  ],
}

const FACT: ObjectDefinition = {
  key: 'fact',
  title: 'נתון',
  fields: [
    { name: 'label', title: 'תווית', kind: 'string', required: true },
    { name: 'value', title: 'ערך', kind: 'string', required: true },
  ],
}

const OPENING_HOURS: ObjectDefinition = {
  key: 'openingHours',
  title: 'שעות פתיחה',
  fields: [
    { name: 'day', title: 'יום', kind: 'string', required: true },
    { name: 'hours', title: 'שעות פתיחה', kind: 'string', required: true },
  ],
}

const MENU_ITEM: ObjectDefinition = {
  key: 'menuItem',
  title: 'מנה',
  fields: [
    { name: 'name', title: 'שם', kind: 'string', required: true },
    { name: 'description', title: 'תיאור', kind: 'text', required: false },
    { name: 'price', title: 'מחיר', kind: 'number', required: false },
    { name: 'tags', title: 'תגיות', kind: 'stringList', required: false, repeated: true },
  ],
}

/* ── hospitality ──────────────────────────────────────────────────────────── */

/**
 * Modelled directly on the production site PRD-v2 measured — nine document
 * types and five shared objects, which is also §13's single acceptance
 * criterion. It is not a sketch of a guest house; it is the shape a real one
 * turned out to need.
 *
 * `siteSettings`, `homePage` and `pricePage` are singletons, and since M15 that
 * is enforced rather than merely intended: the API refuses a second document of
 * each, and the studio offers no "הוספה" for them.
 */
const HOSPITALITY_CONTENT = 'תוכן האתר'
const HOSPITALITY_PRICING = 'מחירים וכללים'
const HOSPITALITY_SOCIAL = 'המלצות וסביבה'

const HOSPITALITY: ContentTemplate = {
  name: 'hospitality',
  description: 'בית הארחה: מתחמי אירוח, מחירון, כללי שהייה, מבצעים, המלצות',
  objects: [PRICE_ROW, NAVIGATION_ITEM, FACT],
  types: [
    {
      key: 'siteSettings',
      title: 'הגדרות האתר',
      titleField: 'title',
      slugField: 'slug',
      cardinality: 'single',
      group: SETTINGS_GROUP,
      fields: [
        TITLE,
        SLUG,
        { name: 'phone', title: 'טלפון', kind: 'string', required: false },
        { name: 'whatsapp', title: 'וואטסאפ', kind: 'string', required: false },
        { name: 'address', title: 'כתובת', kind: 'text', required: false },
        { name: 'logo', title: 'לוגו', kind: 'image', required: false },
        { name: 'navigation', title: 'תפריט ניווט', kind: 'object', required: false, repeated: true, of: 'navigationItem' },
        SEO,
      ],
    },
    {
      key: 'homePage',
      title: 'עמוד הבית',
      titleField: 'title',
      slugField: 'slug',
      cardinality: 'single',
      group: HOSPITALITY_CONTENT,
      fields: [
        TITLE,
        SLUG,
        { name: 'heroImage', title: 'תמונת פתיחה', kind: 'image', required: false },
        { name: 'tagline', title: 'משפט פתיחה', kind: 'text', required: false },
        { name: 'featured', title: 'מתחמים מוצגים', kind: 'reference', required: false, repeated: true, to: ['accommodation'] },
        { name: 'faq', title: 'שאלות ותשובות', kind: 'object', required: false, repeated: true, of: 'faq' },
        { name: 'gallery', title: 'גלריית תמונות', kind: 'object', required: false, repeated: true, of: 'galleryImage' },
        SEO,
      ],
    },
    {
      key: 'accommodation',
      title: 'מתחם אירוח',
      titleField: 'title',
      slugField: 'slug',
      group: HOSPITALITY_CONTENT,
      fields: [
        TITLE,
        SLUG,
        { name: 'heroImage', title: 'תמונת פתיחה', kind: 'image', required: false },
        { name: 'description', title: 'תיאור', kind: 'richtext', required: false },
        { name: 'sleeps', title: 'מספר אורחים', kind: 'number', required: false },
        { name: 'facts', title: 'נתונים', kind: 'object', required: false, repeated: true, of: 'fact' },
        { name: 'gallery', title: 'גלריית תמונות', kind: 'object', required: false, repeated: true, of: 'galleryImage' },
        { name: 'faq', title: 'שאלות ותשובות', kind: 'object', required: false, repeated: true, of: 'faq' },
        { name: 'visibility', title: 'הצגה באתר', kind: 'select', required: false, options: ['listed', 'hidden'] },
        ORDER,
        SEO,
      ],
    },
    {
      key: 'pricePage',
      title: 'מחירון',
      titleField: 'title',
      slugField: 'slug',
      cardinality: 'single',
      group: HOSPITALITY_PRICING,
      fields: [
        TITLE,
        SLUG,
        { name: 'intro', title: 'פסקת פתיחה', kind: 'text', required: false },
        { name: 'rows', title: 'שורות המחירון', kind: 'object', required: false, repeated: true, of: 'priceRow' },
        { name: 'notes', title: 'הערות', kind: 'richtext', required: false },
        SEO,
      ],
    },
    {
      key: 'stayRule',
      title: 'כלל שהייה',
      titleField: 'title',
      slugField: 'slug',
      group: HOSPITALITY_PRICING,
      fields: [
        TITLE,
        SLUG,
        { name: 'minimumNights', title: 'מינימום לילות', kind: 'number', required: false },
        { name: 'appliesFrom', title: 'בתוקף מתאריך', kind: 'date', required: false },
        { name: 'appliesTo', title: 'בתוקף עד תאריך', kind: 'date', required: false },
        { name: 'note', title: 'הערה', kind: 'text', required: false },
      ],
    },
    {
      key: 'promotion',
      title: 'מבצע',
      titleField: 'title',
      slugField: 'slug',
      group: HOSPITALITY_PRICING,
      fields: [
        TITLE,
        SLUG,
        { name: 'body', title: 'תוכן', kind: 'richtext', required: false },
        { name: 'image', title: 'תמונה', kind: 'image', required: false },
        { name: 'startDate', title: 'תאריך התחלה', kind: 'date', required: false },
        { name: 'endDate', title: 'תאריך סיום', kind: 'date', required: false },
        { name: 'status', title: 'מצב', kind: 'select', required: false, options: ['active', 'paused'] },
      ],
    },
    {
      key: 'testimonial',
      title: 'המלצה',
      titleField: 'title',
      slugField: 'slug',
      group: HOSPITALITY_SOCIAL,
      fields: [
        TITLE,
        SLUG,
        { name: 'quote', title: 'ציטוט', kind: 'text', required: false },
        { name: 'author', title: 'שם הממליץ', kind: 'string', required: false },
        { name: 'rating', title: 'דירוג', kind: 'number', required: false },
        ORDER,
      ],
    },
    {
      key: 'areaGuide',
      title: 'המלצה בסביבה',
      titleField: 'title',
      slugField: 'slug',
      group: HOSPITALITY_SOCIAL,
      fields: [
        TITLE,
        SLUG,
        { name: 'summary', title: 'תקציר', kind: 'text', required: false },
        { name: 'body', title: 'תוכן', kind: 'richtext', required: false },
        { name: 'image', title: 'תמונה', kind: 'image', required: false },
        { name: 'distanceKm', title: 'מרחק בק״מ', kind: 'number', required: false },
        { name: 'link', title: 'קישור', kind: 'url', required: false },
        ORDER,
      ],
    },
  ],
}

/* ── clinic ───────────────────────────────────────────────────────────────── */

const CLINIC_TEAM = 'הצוות שלנו'
const CLINIC_TREATMENTS = 'טיפולים'

const CLINIC: ContentTemplate = {
  name: 'clinic',
  description: 'מרפאה: צוות, טיפולים, שאלות נפוצות, שעות פתיחה',
  objects: [OPENING_HOURS, FACT],
  types: [
    {
      key: 'siteSettings',
      title: 'הגדרות האתר',
      titleField: 'title',
      slugField: 'slug',
      cardinality: 'single',
      group: SETTINGS_GROUP,
      fields: [
        TITLE,
        SLUG,
        { name: 'phone', title: 'טלפון', kind: 'string', required: false },
        { name: 'address', title: 'כתובת', kind: 'text', required: false },
        { name: 'hours', title: 'שעות פתיחה', kind: 'object', required: false, repeated: true, of: 'openingHours' },
        SEO,
      ],
    },
    {
      key: 'practitioner',
      title: 'איש צוות',
      titleField: 'title',
      slugField: 'slug',
      group: CLINIC_TEAM,
      fields: [
        TITLE,
        SLUG,
        { name: 'role', title: 'תפקיד', kind: 'string', required: false },
        { name: 'photo', title: 'תמונה', kind: 'image', required: false },
        { name: 'bio', title: 'ביוגרפיה', kind: 'richtext', required: false },
        { name: 'credentials', title: 'הסמכות', kind: 'object', required: false, repeated: true, of: 'fact' },
        ORDER,
      ],
    },
    {
      key: 'treatment',
      title: 'טיפול',
      titleField: 'title',
      slugField: 'slug',
      group: CLINIC_TREATMENTS,
      fields: [
        TITLE,
        SLUG,
        { name: 'summary', title: 'תקציר', kind: 'text', required: false },
        { name: 'body', title: 'תוכן', kind: 'richtext', required: false },
        { name: 'durationMinutes', title: 'משך בדקות', kind: 'number', required: false },
        { name: 'price', title: 'מחיר', kind: 'number', required: false },
        { name: 'faq', title: 'שאלות ותשובות', kind: 'object', required: false, repeated: true, of: 'faq' },
        SEO,
      ],
    },
  ],
}

/* ── restaurant ───────────────────────────────────────────────────────────── */

const RESTAURANT_MENUS = 'תפריטים'

const RESTAURANT: ContentTemplate = {
  name: 'restaurant',
  description: 'מסעדה: תפריטים ומנות, שעות פתיחה, גלריה',
  objects: [MENU_ITEM, OPENING_HOURS],
  types: [
    {
      key: 'siteSettings',
      title: 'הגדרות האתר',
      titleField: 'title',
      slugField: 'slug',
      cardinality: 'single',
      group: SETTINGS_GROUP,
      fields: [
        TITLE,
        SLUG,
        { name: 'phone', title: 'טלפון', kind: 'string', required: false },
        { name: 'address', title: 'כתובת', kind: 'text', required: false },
        { name: 'hours', title: 'שעות פתיחה', kind: 'object', required: false, repeated: true, of: 'openingHours' },
        { name: 'reservationUrl', title: 'קישור להזמנת שולחן', kind: 'url', required: false },
        SEO,
      ],
    },
    {
      key: 'menu',
      title: 'תפריט',
      titleField: 'title',
      slugField: 'slug',
      group: RESTAURANT_MENUS,
      fields: [
        TITLE,
        SLUG,
        { name: 'intro', title: 'פסקת פתיחה', kind: 'text', required: false },
        { name: 'items', title: 'מנות', kind: 'object', required: false, repeated: true, of: 'menuItem' },
        ORDER,
      ],
    },
    {
      key: 'dish',
      title: 'מנה מוצגת',
      titleField: 'title',
      slugField: 'slug',
      group: RESTAURANT_MENUS,
      fields: [
        TITLE,
        SLUG,
        { name: 'photo', title: 'תמונה', kind: 'image', required: false },
        { name: 'description', title: 'תיאור', kind: 'text', required: false },
        { name: 'price', title: 'מחיר', kind: 'number', required: false },
        SEO,
      ],
    },
  ],
}

/* ── portfolio ────────────────────────────────────────────────────────────── */

const PORTFOLIO: ContentTemplate = {
  name: 'portfolio',
  description: 'תיק עבודות: פרויקטים, שירותים, המלצות',
  objects: [FACT],
  types: [
    {
      key: 'project',
      title: 'פרויקט',
      titleField: 'title',
      slugField: 'slug',
      group: 'העבודות שלי',
      fields: [
        TITLE,
        SLUG,
        { name: 'client', title: 'לקוח', kind: 'string', required: false },
        { name: 'summary', title: 'תקציר', kind: 'text', required: false },
        { name: 'body', title: 'תוכן', kind: 'richtext', required: false },
        { name: 'cover', title: 'תמונת נושא', kind: 'image', required: false },
        { name: 'gallery', title: 'גלריית תמונות', kind: 'object', required: false, repeated: true, of: 'galleryImage' },
        { name: 'facts', title: 'נתונים', kind: 'object', required: false, repeated: true, of: 'fact' },
        { name: 'completedAt', title: 'תאריך סיום', kind: 'date', required: false },
        ORDER,
        SEO,
      ],
    },
    {
      key: 'service',
      title: 'שירות',
      titleField: 'title',
      slugField: 'slug',
      group: 'שירותים',
      fields: [
        TITLE,
        SLUG,
        { name: 'summary', title: 'תקציר', kind: 'text', required: false },
        { name: 'body', title: 'תוכן', kind: 'richtext', required: false },
        { name: 'icon', title: 'אייקון', kind: 'image', required: false },
        ORDER,
      ],
    },
    {
      key: 'testimonial',
      title: 'המלצה',
      titleField: 'title',
      slugField: 'slug',
      group: 'המלצות',
      fields: [
        TITLE,
        SLUG,
        { name: 'quote', title: 'ציטוט', kind: 'text', required: false },
        { name: 'author', title: 'שם הממליץ', kind: 'string', required: false },
        ORDER,
      ],
    },
  ],
}

export const TEMPLATES: Readonly<Record<string, ContentTemplate>> = {
  hospitality: HOSPITALITY,
  clinic: CLINIC,
  restaurant: RESTAURANT,
  portfolio: PORTFOLIO,
}

export const TEMPLATE_NAMES: readonly string[] = Object.keys(TEMPLATES)

export function templateNamed(name: string): ContentTemplate | undefined {
  return TEMPLATES[name]
}
