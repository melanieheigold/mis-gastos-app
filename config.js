// Where the engine's API lives. Not secret: every request also needs the token,
// which stays on Melanie's phone and never appears in this repository.
export const API_URL = 'https://script.google.com/macros/s/AKfycbz76ceqL2log8QvWo6TLdkWIhLGg4txoWHxqXvpYenn3ALUhrqof9gZGI4kYazO258F/exec';
export const ENV = 'staging';

// The Firebase project that holds the fast copies. The project id is not a secret and no
// API key is used: access is by each person's space id, which the app learns from their
// engine and keeps on the phone. Must match firebase/config.json. Empty = always ask the engine.
export const FIREBASE = { projectId: 'mis-gastos-d6fcc' };
export const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';
