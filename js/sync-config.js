// STRATUM Sync settings: the Supabase project that keeps producers' beats (see docs/SYNC-SETUP.md).
// Both values are public by design: what each signed-in producer can reach is enforced by the project's security rules.
// Leave them empty and the Sync button stays hidden.
window.STRATUM_SYNC = window.STRATUM_SYNC || {
  url: '',   // e.g. 'https://abcdefghijklmnop.supabase.co'
  key: '',   // the project's "anon" / publishable key
};
