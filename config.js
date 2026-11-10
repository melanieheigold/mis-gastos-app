// Where the engine's API lives. Not secret: every request also needs the token,
// which stays on Melanie's phone and never appears in this repository.
export const API_URL = 'https://script.google.com/macros/s/AKfycbz76ceqL2log8QvWo6TLdkWIhLGg4txoWHxqXvpYenn3ALUhrqof9gZGI4kYazO258F/exec';
export const ENV = 'staging';

// The Firebase project that holds the fast copies (public web config, not a secret:
// access is by each person's space id, which the app learns from their engine).
// Must match firebase/config.json. Empty = the app asks the engine every time.
export const FIREBASE = { projectId: 'mis-gastos-d6fcc', apiKey: 'AIzaSyDRP6hU7xn3iPuF0i4hnM1gxZhvtWZ5IUU' };
export const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';
