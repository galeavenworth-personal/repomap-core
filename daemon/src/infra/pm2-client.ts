import pm2 from "pm2";

export type ProcessDescription = pm2.ProcessDescription;

/** Connect to the PM2 daemon (with 5s timeout to prevent hangs). */
export function pm2Connect(timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`pm2.connect() timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    pm2.connect((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

/** Start a PM2 process using a JSON ecosystem config path. */
export function pm2Start(configPath: string): Promise<pm2.Proc> {
  return new Promise((resolve, reject) => {
    pm2.start(configPath, (err, proc) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(proc);
    });
  });
}

/** List PM2-managed processes. */
export function pm2List(): Promise<pm2.ProcessDescription[]> {
  return new Promise((resolve, reject) => {
    pm2.list((err, processDescriptionList) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(processDescriptionList);
    });
  });
}

/** Stop a PM2 process by name or id. */
export function pm2Stop(target: string | number): Promise<pm2.Proc> {
  return new Promise((resolve, reject) => {
    pm2.stop(target, (err, proc) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(proc);
    });
  });
}

/** Delete a PM2 process by name or id. */
export function pm2Delete(target: string | number): Promise<pm2.Proc> {
  return new Promise((resolve, reject) => {
    pm2.delete(target, (err, proc) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(proc);
    });
  });
}

/** Disconnect from the PM2 daemon. */
export function pm2Disconnect(): void {
  pm2.disconnect();
}

/** Execute an async function with automatic PM2 connect/disconnect lifecycle. */
export async function withPm2Connection<T>(fn: () => Promise<T>): Promise<T> {
  await pm2Connect();
  try {
    return await fn();
  } finally {
    pm2Disconnect();
  }
}

/** Return true when an app is listed and currently online. */
export async function isAppOnline(appName: string): Promise<boolean> {
  try {
    const processes = await pm2List();
    return processes.some((processDescription) => {
      return processDescription.name === appName && processDescription.pm2_env?.status === "online";
    });
  } catch {
    return false;
  }
}
