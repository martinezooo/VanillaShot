import { Action, ActionPanel, Icon, List, Keyboard } from "@raycast/api";
import { useSQL } from "@raycast/utils";
import { useEffect, useMemo, useState } from "react";

import { memoryDatabasePath, runVanillaShotAction } from "./vanillaShot";

type Frame = {
  id: number;
  timestamp: string;
  framePath: string;
  ocrText: string;
  excerpt: string;
};

const RESULT_LIMIT = 50;

/**
 * Turns a free-text query into an FTS5 MATCH expression.
 *
 * useSQL takes a complete SQL string rather than bound parameters, so every
 * character that could terminate the literal or act as an FTS operator is
 * dropped before the value is embedded.
 */
const buildMatchExpression = (raw: string): string | null => {
  const tokens = raw
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}_@.\-/]/gu, ""))
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return null;
  }

  return tokens.map((token) => `"${token}"*`).join(" ");
};

const RECENT_QUERY = `
  SELECT id, timestamp, frame_path AS framePath, ocr_text AS ocrText,
         substr(ocr_text, 1, 200) AS excerpt
  FROM frames
  ORDER BY timestamp DESC
  LIMIT ${RESULT_LIMIT}
`;

/**
 * LIKE fallback for sqlite3 builds without the fts5 module. useSQL spawns
 * whatever `sqlite3` sits on PATH, and that binary is not guaranteed to have
 * fts5 compiled in - the Android platform-tools build, for one, does not.
 */
const buildLikeQuery = (searchText: string): string | null => {
  const tokens = searchText
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}_@.\-/]/gu, ""))
    // `_` is a LIKE wildcard, so it has to be escaped rather than dropped.
    .map((token) => token.replace(/[_\\]/g, (character) => `\\${character}`))
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return null;
  }

  const conditions = tokens.map((token) => `ocr_text LIKE '%${token}%' ESCAPE '\\'`).join(" AND ");

  return `
    SELECT id, timestamp, frame_path AS framePath, ocr_text AS ocrText,
           substr(ocr_text, 1, 200) AS excerpt
    FROM frames
    WHERE ${conditions}
    ORDER BY timestamp DESC
    LIMIT ${RESULT_LIMIT}
  `;
};

const buildQuery = (searchText: string, ftsUnavailable: boolean): string => {
  if (ftsUnavailable) {
    return buildLikeQuery(searchText) ?? RECENT_QUERY;
  }

  const match = buildMatchExpression(searchText);
  if (!match) {
    return RECENT_QUERY;
  }

  return `
    SELECT f.id AS id, f.timestamp AS timestamp, f.frame_path AS framePath,
           f.ocr_text AS ocrText,
           snippet(frames_fts, 0, '', '', '...', 16) AS excerpt
    FROM frames_fts
    JOIN frames f ON f.id = frames_fts.rowid
    WHERE frames_fts MATCH '${match}'
    ORDER BY f.timestamp DESC
    LIMIT ${RESULT_LIMIT}
  `;
};

const formatTimestamp = (value: string): string => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};

const FrameList = ({ databasePath }: { databasePath: string }) => {
  const [searchText, setSearchText] = useState("");
  const [ftsUnavailable, setFtsUnavailable] = useState(false);
  const query = useMemo(() => buildQuery(searchText, ftsUnavailable), [searchText, ftsUnavailable]);
  const { data, isLoading, error, permissionView } = useSQL<Frame>(databasePath, query);

  useEffect(() => {
    if (error && /fts5/i.test(error.message)) {
      setFtsUnavailable(true);
    }
  }, [error]);

  if (permissionView) {
    return permissionView;
  }

  const frames = data ?? [];
  // /fts5/ is handled by falling back to LIKE. Anything else is a real failure
  // and should be shown, not hidden behind an empty "no frames" state.
  const hardError = error && !/fts5/i.test(error.message) ? error : null;

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={frames.length > 0}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Search OCR text from recorded frames"
      throttle
    >
      <List.EmptyView
        icon={hardError ? Icon.Warning : Icon.MagnifyingGlass}
        title={
          hardError
            ? "Could not read the memory database"
            : searchText
              ? "No matching frames"
              : "No frames recorded yet"
        }
        description={
          hardError
            ? hardError.message
            : searchText
              ? "Try a shorter term - matching is prefix-based per word."
              : "Start screen memory in VanillaShot to build a searchable local history."
        }
      />
      {frames.map((frame) => (
        <List.Item
          key={frame.id}
          title={formatTimestamp(frame.timestamp)}
          subtitle={frame.excerpt?.replace(/\s+/g, " ").trim()}
          icon={Icon.Window}
          detail={
            <List.Item.Detail
              markdown={`![frame](file://${encodeURI(frame.framePath)})`}
              metadata={
                <List.Item.Detail.Metadata>
                  <List.Item.Detail.Metadata.Label title="Captured" text={formatTimestamp(frame.timestamp)} />
                  <List.Item.Detail.Metadata.Label title="File" text={frame.framePath} />
                </List.Item.Detail.Metadata>
              }
            />
          }
          actions={
            <ActionPanel>
              <Action.Open title="Open Frame" target={frame.framePath} />
              <Action.ShowInFinder path={frame.framePath} />
              <Action.CopyToClipboard
                title="Copy OCR Text"
                content={frame.ocrText ?? ""}
                shortcut={Keyboard.Shortcut.Common.Pin}
              />
              <Action
                title="Capture Region"
                icon={Icon.Crop}
                shortcut={{ modifiers: ["cmd", "shift"], key: "1" }}
                onAction={() => runVanillaShotAction("capture", "Drag to select a region")}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
};

export default function Command() {
  const databasePath = useMemo(() => memoryDatabasePath(), []);

  if (!databasePath) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.QuestionMark}
          title="No VanillaShot memory database found"
          description="Start screen memory in VanillaShot once to create ~/Pictures/VanillaShot Memory/memory.db."
        />
      </List>
    );
  }

  return <FrameList databasePath={databasePath} />;
}
