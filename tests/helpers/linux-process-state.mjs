import { readFile } from 'node:fs/promises';

// A zombie has terminated but may not yet have been reaped by its parent.
export async function isLinuxProcessTerminated(pid, readStatus = readFile) {
  try {
    return /\) Z /.test(await readStatus(`/proc/${pid}/stat`, 'utf8'));
  } catch (error) {
    // Exit can race either opening the path (ENOENT) or reading an already
    // opened proc file (ESRCH). Both mean the observed task is gone.
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return true;
    throw error;
  }
}
