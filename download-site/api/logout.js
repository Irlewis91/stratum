import { cookie, redirect } from '../lib/gate.js';

export const GET = () => redirect('/', [cookie('stratum_session', '', 0)]);
