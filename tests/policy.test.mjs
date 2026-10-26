import assert from 'node:assert/strict'
import test from 'node:test'
import { hostnameOf, policyViolation } from '../lib/routes.js'

const LOOPBACK = { headers: { host: '127.0.0.1:64283' } }

test('hostnameOf drops the port and keeps an IPv6 literal bracketed', () => {
  assert.equal(hostnameOf('127.0.0.1:64283'), '127.0.0.1')
  assert.equal(hostnameOf('localhost'), 'localhost')
  assert.equal(hostnameOf('[::1]:64283'), '[::1]')
  assert.equal(hostnameOf(' 127.0.0.1:1 '), '127.0.0.1')
})

test('a loopback request without Origin is allowed', () => {
  assert.equal(policyViolation(LOOPBACK), null)
  assert.equal(policyViolation({ headers: { host: 'localhost:1' } }), null)
  assert.equal(policyViolation({ headers: { host: '[::1]:1' } }), null)
})

test('a missing Host header is refused', () => {
  assert.equal(policyViolation({ headers: {} }).status, 403)
})

test('a non-loopback Host is refused, which is what blocks DNS rebinding', () => {
  assert.equal(policyViolation({ headers: { host: 'evil.example' } }).status, 403)
  assert.equal(policyViolation({ headers: { host: 'evil.example:64283' } }).status, 403)
  assert.equal(policyViolation({ headers: { host: '192.168.1.10:64283' } }).status, 403)
})

test('an Origin from another host is refused', () => {
  const violation = policyViolation({ headers: { host: '127.0.0.1:64283', origin: 'https://evil.example' } })
  assert.equal(violation.status, 403)
  assert.match(violation.message, /cross-origin/)
})

test('an opaque "null" Origin is refused', () => {
  assert.equal(policyViolation({ headers: { host: '127.0.0.1:64283', origin: 'null' } }).status, 403)
})

test('the origin of the same host and port is allowed, on either scheme', () => {
  const http = { headers: { host: '127.0.0.1:64283', origin: 'http://127.0.0.1:64283' } }
  assert.equal(policyViolation(http), null)
  // The trust boundary is the server on that host; a scheme change is not a
  // different peer, and comparing the full origin would break such a window.
  const https = { headers: { host: '127.0.0.1:64283', origin: 'https://127.0.0.1:64283' } }
  assert.equal(policyViolation(https), null)
  const otherPort = { headers: { host: '127.0.0.1:64283', origin: 'http://127.0.0.1:64284' } }
  assert.equal(policyViolation(otherPort).status, 403)
  const otherHost = { headers: { host: '127.0.0.1:64283', origin: 'http://localhost:64283' } }
  assert.equal(policyViolation(otherHost).status, 403)
})

test('a cross-site Sec-Fetch-Site is refused even with a matching origin', () => {
  const req = { headers: { host: '127.0.0.1:64283', 'sec-fetch-site': 'cross-site' } }
  assert.equal(policyViolation(req).status, 403)
  const sameSite = { headers: { host: '127.0.0.1:64283', 'sec-fetch-site': 'same-site' } }
  assert.equal(policyViolation(sameSite).status, 403)
  const typed = { headers: { host: '127.0.0.1:64283', 'sec-fetch-site': 'none' } }
  assert.equal(policyViolation(typed), null)
})
