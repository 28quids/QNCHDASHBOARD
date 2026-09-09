/**
 * The slice of the Google Sheets API v4 this export needs.
 *
 * Four operations: read the workbook's structure, create a tab, write a range, and protect what
 * was written. Nothing reads user data back — this is a one-way export, so a mistake here can
 * overwrite a tab but can never feed a spreadsheet's contents into the financial model.
 */

import { fetchWithRetry, HttpError } from "../http";

const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

export interface SheetsClientOptions {
  spreadsheetId: string;
  accessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface SheetProperties {
  sheetId: number;
  title: string;
}

/** A cell value as the API accepts it. Null clears the cell rather than writing "null". */
export type CellValue = string | number | boolean | null;

export interface RangeUpdate {
  /** A1 notation including the sheet name, e.g. `03_DAILY_P&L!A1`. */
  range: string;
  values: CellValue[][];
}

export class SheetsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep?: (ms: number) => Promise<void>;

  constructor(private readonly options: SheetsClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${API_BASE}/${this.options.spreadsheetId}${path}`;
    const token = await this.options.accessToken();

    const response = await fetchWithRetry(
      () =>
        this.fetchImpl(url, {
          ...init,
          headers: {
            ...init.headers,
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }),
      { sleep: this.sleep },
    );

    const body = await response.text();
    if (!response.ok) {
      // 403 here is nearly always the workbook not being shared with the service account, which
      // is invisible from the Google Cloud console and easy to spend an hour on.
      const hint =
        response.status === 403
          ? " Share the spreadsheet with the service-account email address, as an Editor."
          : "";
      throw new HttpError(response.status, url, `${body}${hint}`);
    }

    return body === "" ? ({} as T) : (JSON.parse(body) as T);
  }

  /** The tabs the workbook currently has, so a missing one can be created before it is written. */
  async listSheets(): Promise<SheetProperties[]> {
    const payload = await this.request<{ sheets?: { properties: SheetProperties }[] }>(
      "?fields=sheets.properties.sheetId,sheets.properties.title",
    );
    return (payload.sheets ?? []).map((sheet) => sheet.properties);
  }

  async addSheets(titles: readonly string[]): Promise<void> {
    if (titles.length === 0) return;

    await this.request("/:batchUpdate", {
      method: "POST",
      body: JSON.stringify({
        requests: titles.map((title) => ({ addSheet: { properties: { title } } })),
      }),
    });
  }

  /**
   * Writes several ranges in one request.
   *
   * `RAW` rather than `USER_ENTERED`: a value must be stored exactly as given. Under
   * `USER_ENTERED` a SKU like `-ORANGE` becomes a formula error and a code like `1-2` becomes a
   * date, which is a silent corruption of imported data.
   */
  async updateValues(updates: readonly RangeUpdate[]): Promise<number> {
    if (updates.length === 0) return 0;

    const payload = await this.request<{ totalUpdatedCells?: number }>("/values:batchUpdate", {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "RAW", data: updates }),
    });
    return payload.totalUpdatedCells ?? 0;
  }

  /** Empties a tab before it is rewritten, so a shorter export cannot leave old rows below it. */
  async clearRanges(ranges: readonly string[]): Promise<void> {
    if (ranges.length === 0) return;

    await this.request("/values:batchClear", {
      method: "POST",
      body: JSON.stringify({ ranges }),
    });
  }

  /**
   * Marks a tab as imported data.
   *
   * `warningOnly` rather than a hard lock, deliberately. A hard lock would also exclude the
   * owner, and the risk being managed is an accidental edit rather than a malicious one — an
   * imported figure quietly overtyped is how a workbook comes to disagree with the database
   * nobody can explain.
   */
  async protectSheets(sheetIds: readonly number[], description: string): Promise<void> {
    if (sheetIds.length === 0) return;

    await this.request("/:batchUpdate", {
      method: "POST",
      body: JSON.stringify({
        requests: sheetIds.map((sheetId) => ({
          addProtectedRange: {
            protectedRange: { range: { sheetId }, description, warningOnly: true },
          },
        })),
      }),
    });
  }

  /** Existing protections, so re-running the export does not stack another one every night. */
  async listProtectedSheetIds(): Promise<Set<number>> {
    const payload = await this.request<{
      sheets?: { properties: SheetProperties; protectedRanges?: { range?: { sheetId?: number } }[] }[];
    }>("?fields=sheets.properties.sheetId,sheets.properties.title,sheets.protectedRanges.range.sheetId");

    const protectedIds = new Set<number>();
    for (const sheet of payload.sheets ?? []) {
      if ((sheet.protectedRanges ?? []).length > 0) protectedIds.add(sheet.properties.sheetId);
    }
    return protectedIds;
  }
}
