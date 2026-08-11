import fs from "node:fs";

/**
 * Checks if the current process is running inside a Docker container.
 * Uses the standard `/.dockerenv` file check with a cgroups fallback.
 */
export function isDocker(): boolean {
    try {
        // Primary check: Docker daemon creates `/.dockerenv` at root on startup
        if (fs.existsSync("/.dockerenv")) {
            return true;
        }
        // Fallback check for cgroups v1 environments
        if (fs.existsSync("/proc/1/cgroup")) {
            const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
            return cgroup.includes("docker") || cgroup.includes("kubepods");
        }
    } catch {
        return false;
    }
    return false;
}