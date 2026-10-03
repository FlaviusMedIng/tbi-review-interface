/* Déchiffrement des fichiers de données (format produit par automation/build_webui_data.py).
   {"v":1,"kdf":"PBKDF2-SHA256","iter":600000,"salt":b64,"iv":b64,"ct":b64}  — AES-256-GCM, ct = chiffré || tag.
   Fichier sans dépendance, utilisable dans le navigateur (window.TBICrypto) et dans Node (globalThis.TBICrypto). */
(function (root) {
  'use strict';

  function b64ToBytes(s) {
    var bin = root.atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function decryptEnvelope(env, passphrase, subtle) {
    subtle = subtle || root.crypto.subtle;
    if (!env || env.v !== 1 || env.kdf !== 'PBKDF2-SHA256' || !env.iter || !env.salt || !env.iv || !env.ct) {
      throw new Error('Format de fichier chiffré inconnu');
    }
    var base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    var key = await subtle.deriveKey(
      { name: 'PBKDF2', salt: b64ToBytes(env.salt), iterations: env.iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    var plain = await subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(env.iv) }, key, b64ToBytes(env.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  root.TBICrypto = { decryptEnvelope: decryptEnvelope, b64ToBytes: b64ToBytes };
})(typeof window !== 'undefined' ? window : globalThis);
