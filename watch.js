// One pass of the rented computers' guards without the server. Run on a schedule of its own (a Render cron job:
// `node watch.js` every five minutes), so a rented machine is still ended on time while the server is down.
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const { connectDB } = await import('./config/db.js');
await connectDB();
const { watchRentals } = await import('./controllers/ai.controller.js');

let code = 0;
try {
    console.log(JSON.stringify({ at: new Date().toISOString(), ...(await watchRentals({ alone: true }) || { off: true }) }));
} catch (error) {
    console.error('The rented computers could not be checked:', error.message);
    code = 1;
}
// Notices written during the pass are saved before leaving.
await new Promise((resolve) => setTimeout(resolve, 2000));
process.exit(code);
