import fs from "fs/promises";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import path from "path";
import os from "os";

const DEFAULT_API_BASE = "https://platform.plaud.ai/developer/api";
const DEFAULT_REFRESH_URL = "https://platform.plaud.ai/developer/api/oauth/third-party/access-token/refresh";

export class PlaudClient {
  constructor(options = {}) {
    this.tokenPath = options.tokenPath || path.join(os.homedir(), ".plaud", "tokens-mcp.json");
    this.apiBase = options.apiBase || DEFAULT_API_BASE;
    this.refreshUrl = options.refreshUrl || DEFAULT_REFRESH_URL;
    this.tokenSet = null;
  }

  async loadTokens() {
    try {
      const data = await fs.readFile(this.tokenPath, "utf-8");
      this.tokenSet = JSON.parse(data);
      return this.tokenSet;
    } catch (err) {
      throw new Error(
        `Failed to load Plaud authentication tokens from ${this.tokenPath} (${err.message}).\n` +
        `Please authenticate by running:\n` +
        `  npm run login\n` +
        `or:\n` +
        `  npx -y @plaud-ai/mcp install --yes`
      );
    }
  }

  async saveTokens(tokens) {
    this.tokenSet = { ...this.tokenSet, ...tokens };
    await fs.mkdir(path.dirname(this.tokenPath), { recursive: true });
    await fs.writeFile(this.tokenPath, JSON.stringify(this.tokenSet, null, 2), "utf-8");
  }

  async getAccessToken() {
    if (!this.tokenSet) {
      await this.loadTokens();
    }
    const { access_token, refresh_token, expires_at } = this.tokenSet;

    // Check if token is expired (or expires within 60s)
    if (expires_at && Date.now() > expires_at - 60000) {
      if (refresh_token) {
        console.log("Token expired. Refreshing Plaud access token...");
        await this.refreshTokens(refresh_token);
        return this.tokenSet.access_token;
      }
    }
    return access_token;
  }

  async refreshTokens(refreshToken) {
    const res = await fetch(this.refreshUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: new URLSearchParams({ refresh_token: refreshToken })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Token refresh failed (HTTP ${res.status}): ${body}`);
    }

    const data = await res.json();
    const tokenSet = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      token_type: data.token_type || "Bearer",
      expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : Date.now() + 3600000
    };
    await this.saveTokens(tokenSet);
    console.log("Plaud access token refreshed successfully.");
    return tokenSet;
  }

  async request(endpoint, init = {}, retryOnAuth = true) {
    const token = await this.getAccessToken();
    const url = endpoint.startsWith("http") ? endpoint : `${this.apiBase}${endpoint}`;

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init.headers || {})
    };

    const res = await fetch(url, { ...init, headers });

    if (res.status === 401 && retryOnAuth && this.tokenSet?.refresh_token) {
      console.log("Received 401 Unauthorized. Retrying with refreshed token...");
      await this.refreshTokens(this.tokenSet.refresh_token);
      return this.request(endpoint, init, false);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`API error (${res.status} ${res.statusText}): ${body}`);
    }

    return res.json();
  }

  async listFiles(page = 1, pageSize = 50) {
    return this.request(`/open/third-party/files/?page=${page}&page_size=${pageSize}`);
  }

  async listAllFiles() {
    const allFiles = [];
    let page = 1;
    const pageSize = 50;

    while (true) {
      const res = await this.listFiles(page, pageSize);
      const items = res.data || [];
      if (items.length === 0) break;

      allFiles.push(...items);
      if (items.length < pageSize) break;
      page++;
    }

    return allFiles;
  }

  async getFile(fileId) {
    return this.request(`/open/third-party/files/${fileId}`);
  }

  async loadBlockContent(block) {
    if (!block) return "";
    const inline = block.data_content;
    if (typeof inline === "string" && inline.length > 0) {
      return inline;
    }
    const link = block.data_link;
    if (typeof link === "string" && link.length > 0) {
      const res = await fetch(link);
      if (!res.ok) {
        throw new Error(`Failed to fetch block content from data_link (HTTP ${res.status})`);
      }
      return res.text();
    }
    return "";
  }

  async downloadFile(url, destPath) {
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to download file from ${url} (HTTP ${res.status})`);
    }

    const fileStream = createWriteStream(destPath);
    await pipeline(res.body, fileStream);
  }
}
