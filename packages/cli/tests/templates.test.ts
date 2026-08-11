import { describe, expect, it } from 'vitest'

import { OBJECT_LIST } from '../../sdk/src/definitions'
import { TEMPLATES, TEMPLATE_NAMES, templateNamed } from '../src/templates'
import { parseFieldSpec } from '../src/field-spec'

/**
 * The content-model templates (M11 / PRD-v2 §3.4).
 *
 * These are data, so the tests are about internal consistency — the class of
 * mistake that would otherwise surface as a 422 on a customer's first command.
 * A template referring to an object it does not bring, or naming a `titleField`
 * that is not one of its fields, is caught here rather than by the API.
 */

const SEEDED_OBJECTS = new Set(OBJECT_LIST.map((object) => object.key))

describe('every template', () => {
  it.each(TEMPLATE_NAMES)('%s: names itself consistently', (name) => {
    expect(templateNamed(name)?.name).toBe(name)
  })

  it.each(TEMPLATE_NAMES)('%s: every object field points at a shape that will exist', (name) => {
    const template = templateNamed(name)
    if (template === undefined) throw new Error(`no template ${name}`)

    // Available = what the template brings, plus what every project is seeded
    // with. Anything else is a 422 on `templates apply`, halfway through.
    const available = new Set([
      ...SEEDED_OBJECTS,
      ...template.objects.map((object) => object.key),
    ])

    for (const type of template.types) {
      for (const field of type.fields) {
        if (field.kind !== 'object') continue
        expect(field.of, `${name}/${type.key}.${field.name}`).toBeDefined()
        expect(available.has(field.of ?? ''), `${name}/${type.key}.${field.name} → ${field.of ?? ''}`).toBe(true)
      }
    }
  })

  it.each(TEMPLATE_NAMES)('%s: never redefines a shape every project already has', (name) => {
    // `faq` and `galleryImage` are seeded. Redefining one is a 409 telling the
    // operator something "already exists" that they never created.
    const template = templateNamed(name)
    for (const object of template?.objects ?? []) {
      expect(SEEDED_OBJECTS.has(object.key), `${name} redefines ${object.key}`).toBe(false)
    }
  })

  it.each(TEMPLATE_NAMES)('%s: titleField and slugField are real fields', (name) => {
    const template = templateNamed(name)
    for (const type of template?.types ?? []) {
      const names = new Set(type.fields.map((field) => field.name))
      expect(names.has(type.titleField), `${name}/${type.key}.titleField`).toBe(true)
      expect(names.has(type.slugField), `${name}/${type.key}.slugField`).toBe(true)
    }
  })

  it.each(TEMPLATE_NAMES)('%s: no duplicate field names, keys or object keys', (name) => {
    const template = templateNamed(name)
    if (template === undefined) throw new Error(`no template ${name}`)

    const typeKeys = template.types.map((type) => type.key)
    expect(new Set(typeKeys).size, `${name} type keys`).toBe(typeKeys.length)

    const objectKeys = template.objects.map((object) => object.key)
    expect(new Set(objectKeys).size, `${name} object keys`).toBe(objectKeys.length)

    for (const definition of [...template.types, ...template.objects]) {
      const fieldNames = definition.fields.map((field) => field.name)
      expect(new Set(fieldNames).size, `${name}/${definition.key}`).toBe(fieldNames.length)
    }
  })

  it.each(TEMPLATE_NAMES)('%s: every key is a usable identifier', (name) => {
    // They become TypeScript property names and URL segments; the API enforces
    // this too, but failing here names the template rather than the request.
    const identifier = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
    const template = templateNamed(name)
    if (template === undefined) throw new Error(`no template ${name}`)

    for (const definition of [...template.types, ...template.objects]) {
      expect(identifier.test(definition.key), `${name}/${definition.key}`).toBe(true)
      for (const field of definition.fields) {
        expect(identifier.test(field.name), `${name}/${definition.key}.${field.name}`).toBe(true)
        expect(field.name.startsWith('_'), `${name}/${definition.key}.${field.name}`).toBe(false)
      }
    }
  })

  it.each(TEMPLATE_NAMES)('%s: every select brings its options', (name) => {
    const template = templateNamed(name)
    for (const definition of [...(template?.types ?? []), ...(template?.objects ?? [])]) {
      for (const field of definition.fields) {
        if (field.kind !== 'select') continue
        expect((field.options ?? []).length, `${name}/${definition.key}.${field.name}`).toBeGreaterThan(0)
      }
    }
  })

  it.each(TEMPLATE_NAMES)('%s: every reference points at a type the template defines', (name) => {
    const template = templateNamed(name)
    if (template === undefined) throw new Error(`no template ${name}`)
    // Plus the four every project is seeded with.
    const available = new Set([
      'page',
      'post',
      'product',
      'collection',
      ...template.types.map((type) => type.key),
    ])

    for (const type of template.types) {
      for (const field of type.fields) {
        if (field.kind !== 'reference') continue
        for (const target of field.to ?? []) {
          expect(available.has(target), `${name}/${type.key}.${field.name} → ${target}`).toBe(true)
        }
      }
    }
  })

  it.each(TEMPLATE_NAMES)('%s: has a Hebrew title on every type', (name) => {
    // §13: the title is what a business owner reads in the studio. A key that
    // leaked into a title is the jargon that rule exists to keep out.
    const template = templateNamed(name)
    for (const type of template?.types ?? []) {
      expect(type.title, `${name}/${type.key}`).not.toBe(type.key)
      expect(/[֐-׿]/.test(type.title), `${name}/${type.key} is not Hebrew`).toBe(true)
    }
  })
})

describe('the hospitality template', () => {
  // PRD-v2 §13's acceptance criterion is that the reference site's model loads
  // in one command. This is that model.
  const template = TEMPLATES['hospitality']

  it('covers the reference site’s document types', () => {
    expect(template?.types.map((type) => type.key).sort()).toEqual(
      [
        'accommodation',
        'areaGuide',
        'homePage',
        'pricePage',
        'promotion',
        'siteSettings',
        'stayRule',
        'testimonial',
      ].sort(),
    )
  })

  it('reaches nine types once the seeded `page` is counted', () => {
    // The reference site has nine. `page` is the one of them that already maps
    // onto a seeded type, so the template does not redefine it.
    expect((template?.types.length ?? 0) + 1).toBe(9)
  })

  it('uses array<object> where the reference site does', () => {
    const accommodation = template?.types.find((type) => type.key === 'accommodation')
    const gallery = accommodation?.fields.find((field) => field.name === 'gallery')
    expect(gallery).toMatchObject({ kind: 'object', repeated: true, of: 'galleryImage' })
  })
})

describe('the compact field syntax covers what the templates use', () => {
  it('round-trips every non-object field in every template', () => {
    // If a template needs a shape the CLI's own `--field` syntax cannot express,
    // an agent cannot reproduce or extend it by hand — which would make the
    // templates a closed system rather than a starting point.
    for (const name of TEMPLATE_NAMES) {
      const template = templateNamed(name)
      for (const definition of [...(template?.types ?? []), ...(template?.objects ?? [])]) {
        for (const field of definition.fields) {
          if (field.kind === 'object' || field.kind === 'reference' || field.kind === 'blocks') {
            continue
          }
          const spec = `${field.name}:${field.kind}${field.repeated === true ? '[]' : ''}${
            field.required ? '!' : ''
          }${field.options === undefined ? '' : `=${field.options.join('|')}`}`
          expect(parseFieldSpec(spec).name, `${name}/${definition.key}.${field.name}`).toBe(
            field.name,
          )
        }
      }
    }
  })
})
