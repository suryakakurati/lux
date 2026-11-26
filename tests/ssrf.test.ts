import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertPublicUrl, isBlockedTarget, isPrivateAddress } from '../electron/main/web/read.ts'

test('loopback, private, link-local and CGNAT addresses are private', () => {
  for (const address of [
    '127.0.0.1',
    '127.9.9.9',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1'
  ]) {
    assert.equal(isPrivateAddress(address), true, `${address} should be private`)
  }
})

test('public addresses stay readable', () => {
  for (const address of ['93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, `${address} should be public`)
  }
})

test('a page read never targets this machine or a non-http scheme', async () => {
  const blocked = [
    'http://127.0.0.1:11434/api/tags',
    'http://localhost:3000/',
    'http://[::1]:8080/',
    'http://192.168.1.1/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://printer.local/status',
    'file:///etc/passwd',
    'ftp://example.com/x'
  ]
  for (const url of blocked) {
    await assert.rejects(() => assertPublicUrl(url), `${url} must be refused`)
  }
})

test('URLs with embedded credentials are refused', async () => {
  await assert.rejects(() => assertPublicUrl('https://user:pass@example.com/'))
})

test('the browser treats every local or non-web target as blocked', () => {
  for (const url of [
    'http://127.0.0.1:11434/api/tags',
    'http://localhost:3000/admin',
    'http://[::1]/',
    'http://10.0.0.1/',
    'http://printer.local/',
    'http://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
    'about:blank',
    'javascript:alert(1)',
    'not a url'
  ]) {
    assert.equal(isBlockedTarget(url), true, `${url} must be blocked`)
  }
})

test('the browser still navigates to ordinary public pages', () => {
  for (const url of ['https://example.com/a?b=1', 'http://news.ycombinator.com/', 'https://93.184.216.34/']) {
    assert.equal(isBlockedTarget(url), false, `${url} should be allowed`)
  }
})
