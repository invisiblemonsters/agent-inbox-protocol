// Generate Ed25519 keypair for AIP agent identity
const nacl = require('tweetnacl');
const { encodeBase64 } = require('tweetnacl-util');
const fs = require('fs');
const path = require('path');

const keypair = nacl.sign.keyPair();

const keys = {
  publicKey: encodeBase64(keypair.publicKey),
  secretKey: encodeBase64(keypair.secretKey),
  created: new Date().toISOString(),
  note: 'AIP agent identity keypair (Ed25519). Keep secretKey private.'
};

const outPath = path.join(__dirname, 'agent-keys.json');
fs.writeFileSync(outPath, JSON.stringify(keys, null, 2));
console.log('Agent keypair generated:');
console.log('  Public Key:', keys.publicKey);
console.log('  Saved to:', outPath);
