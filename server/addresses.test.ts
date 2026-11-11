import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, serveHttps } from './addresses.ts';

test('LAN and Tailscale addresses are told apart; link-local and public are dropped', () => {
  const a = classify(['192.168.0.20', '169.254.97.118', '100.101.102.103', '10.0.0.5', '172.29.192.1', '100.63.0.1', '100.128.0.1', '8.8.8.8']);
  assert.deepEqual(a.lan, ['192.168.0.20', '10.0.0.5', '172.29.192.1']);
  // 100.63 sits just under the Tailscale range and 100.128 just over it
  assert.deepEqual(a.tailscale, ['100.101.102.103']);
});

test('serve status is read for the ts.net name; "not enabled" and "no config" give null', () => {
  assert.equal(serveHttps('https://desk-pc.example-tailnet.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:4771\n'), 'https://desk-pc.example-tailnet.ts.net');
  assert.equal(serveHttps('No serve config\n'), null);
  // the enable link is on login.tailscale.com, which must not pass as the deck
  assert.equal(serveHttps('Serve is not enabled on your tailnet.\nTo enable, visit:\n\n\thttps://login.tailscale.com/f/serve?node=abc\n'), null);
});
