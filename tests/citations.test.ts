import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  citationFailure,
  citationStats,
  extractUrls,
  hostOf,
  normaliseUrl
} from '../shared/citations.ts'

test('urls normalise across scheme, www, fragments and trailing slashes', () => {
  assert.equal(normaliseUrl('https://www.Example.com/Path/'), 'example.com/Path')
  assert.equal(normaliseUrl('http://example.com/Path#section'), 'example.com/Path')
  assert.equal(normaliseUrl('https://example.com/Path?q=1'), 'example.com/Path?q=1')
  assert.equal(normaliseUrl('mailto:someone@example.com'), null)
  assert.equal(hostOf('https://www.example.com/a'), 'example.com')
})

test('markdown links, angle brackets and sentence punctuation do not corrupt a URL', () => {
  const text = [
    'See [1](https://example.com/a).',
    'Also <https://www.example.org/b?q=1>, and (https://example.com/a).',
    'Not a link: example.com/c'
  ].join(' ')
  assert.deepEqual(extractUrls(text), [
    'https://example.com/a',
    'https://www.example.org/b?q=1'
  ])
})

test('a citation only counts when the same page appeared in the evidence', () => {
  const evidence = ['https://example.com/a', 'https://docs.example.org/b']
  const good = citationStats('Both agree ([1] https://example.com/a, [2] https://docs.example.org/b).', evidence)
  assert.equal(good.total, 2)
  assert.equal(good.backed, 2)
  assert.equal(good.unbacked, 0)
  assert.equal(good.backedHosts, 2)

  const invented = citationStats('Both agree (https://example.com/a and https://made-up.example/z).', evidence)
  assert.equal(invented.backed, 1)
  assert.equal(invented.unbacked, 1)
})

test('citation requirements catch missing, invented and single-host sources', () => {
  const evidence = ['https://a.example/x', 'https://b.example/y']
  assert.match(
    citationFailure('No links here.', evidence, { citations: 2 }) ?? '',
    /no source URL/
  )
  assert.match(
    citationFailure('One ([1] https://a.example/x).', evidence, { citations: 2 }) ?? '',
    /only 1\/2/
  )
  assert.match(
    citationFailure(
      'Invented ([1] https://a.example/x, [2] https://never.example/z).',
      evidence,
      { citations: 2 }
    ) ?? '',
    /never returned/
  )
  assert.match(
    citationFailure(
      'Same host ([1] https://a.example/x, [2] https://a.example/other).',
      ['https://a.example/x', 'https://a.example/other'],
      { citations: 2, hosts: 2 }
    ) ?? '',
    /1 host/
  )
  assert.equal(
    citationFailure(
      'Good ([1] https://a.example/x, [2] https://b.example/y).',
      evidence,
      { citations: 2, hosts: 2 }
    ),
    null
  )
})
