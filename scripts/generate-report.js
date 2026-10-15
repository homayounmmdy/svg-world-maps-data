#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const MAPS_DIR = path.join(process.cwd(), "maps");
const OUTPUT_FILE = path.join(process.cwd(), "MAPS_INFO.md");

function extractMapInfo(content, fileName) {
  const command = fileName.replace(/\.ts$/i, "").toLowerCase();
  const nameMatch = content.match(/\bname\s*:\s*["']([^"']+)["']/);
  const mapName = nameMatch ? nameMatch[1] : command;
  const codeMatch = content.match(/\bcode\s*:\s*["']([^"']+)["']/);
  const mapCode = codeMatch ? codeMatch[1] : "N/A";

  let stateCount = 0;
  const statesMatch = content.match(/\bstates\s*:\s*\[/);
  if (statesMatch) {
    const startIndex = statesMatch.index + statesMatch[0].length;
    const restOfContent = content.slice(startIndex);
    let depth = 1;
    let endIndex = 0;
    for (let i = 0; i < restOfContent.length; i++) {
      const char = restOfContent[i];
      if (char === "[") depth++;
      else if (char === "]") depth--;
      if (depth === 0) {
        endIndex = i;
        break;
      }
    }
    if (endIndex > 0) {
      const statesBlock = restOfContent.slice(0, endIndex);
      const nameMatchesInStates = statesBlock.match(
        /\bname\s*:\s*["'][^"']*["']/g,
      );
      stateCount = nameMatchesInStates ? nameMatchesInStates.length : 0;
    }
  }

  const hasLabels = /\blabels\s*:\s*\[[^\]]*\{/.test(content) ? "Yes" : "No";

  // Detect a `capitals:` property. It may be a string OR an array literal.
  // Examples we accept:
  //   capitals: "Berlin",
  //   capitals: { name: "Berlin", x: "...", y: "..." },
  //   capitals: [ { name: "Pretoria", ... }, ... ],
  const capitalsMatch = content.match(/\bcapitals\s*:\s*/);
  let hasCapitals = "No";
  let capitalCount = 0;
  let capitalNames = [];

  if (capitalsMatch) {
    const afterIdx = capitalsMatch.index + capitalsMatch[0].length;
    const after = content.slice(afterIdx);

    const trimmed = after.replace(/^[\s\r\n]+/, "");
    const firstChar = trimmed[0];

    if (firstChar === "[") {
      // Array form — bracket match to get the full block
      let depth = 0;
      let end = -1;
      for (let i = 0; i < trimmed.length; i++) {
        const c = trimmed[i];
        if (c === "[") depth++;
        else if (c === "]") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end !== -1) {
        const block = trimmed.slice(1, end);
        const names = block.match(/\bname\s*:\s*["'`]([^"'`]+)["'`]/g) || [];
        capitalNames = names
          .map((n) => {
            const m = n.match(/["'`]([^"'`]+)["'`]/);
            return m ? m[1] : null;
          })
          .filter(Boolean);
        capitalCount = capitalNames.length;
        hasCapitals = capitalCount > 0 ? "Yes" : "No";
      }
    } else if (firstChar === "{") {
      // Single object form
      const objMatch = trimmed.match(/\{[^{}]*\}/);
      if (objMatch) {
        const nm = objMatch[0].match(/\bname\s*:\s*["'`]([^"'`]+)["'`]/);
        if (nm) {
          capitalNames = [nm[1]];
          capitalCount = 1;
          hasCapitals = "Yes";
        }
      }
    } else if (firstChar === '"' || firstChar === "'" || firstChar === "`") {
      // Plain string form
      const sm = trimmed.match(/^["'`]([^"'`]+)["'`]/);
      if (sm) {
        capitalNames = [sm[1]];
        capitalCount = 1;
        hasCapitals = "Yes";
      }
    }
  }

  return {
    command,
    mapName,
    mapCode,
    stateCount,
    hasLabels,
    hasCapitals,
    capitalCount,
    capitalNames,
  };
}

async function main() {
  try {
    if (!fs.existsSync(MAPS_DIR)) {
      console.error(`❌ Error: Directory not found at ${MAPS_DIR}`);
      process.exit(1);
    }

    const files = fs
      .readdirSync(MAPS_DIR)
      .filter((file) => file.endsWith(".ts"));
    if (files.length === 0) {
      console.log("⚠️ No .ts map files found in the directory.");
      process.exit(0);
    }

    const mapInfos = files.map((file) => {
      const filePath = path.join(MAPS_DIR, file);
      const content = fs.readFileSync(filePath, "utf8");
      return extractMapInfo(content, file);
    });

    // Sort alphabetically by country name
    mapInfos.sort((a, b) => a.mapName.localeCompare(b.mapName));

    const generatedAt = new Date().toLocaleString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });

    const withLabels = mapInfos.filter((info) => info.hasLabels === "Yes");
    const withoutLabels = mapInfos.filter((info) => info.hasLabels === "No");

    const withCapitals = mapInfos.filter((info) => info.hasCapitals === "Yes");
    const withoutCapitals = mapInfos.filter(
      (info) => info.hasCapitals === "No",
    );

    const totalStates = mapInfos.reduce(
      (sum, info) => sum + info.stateCount,
      0,
    );
    const labelCoverage = ((withLabels.length / mapInfos.length) * 100).toFixed(
      1,
    );
    const capitalCoverage = (
      (withCapitals.length / mapInfos.length) *
      100
    ).toFixed(1);

    // Build Markdown
    let md = `# 🗺️ Maps Information Report\n\n`;
    md += `**📅 Last Generated:** ${generatedAt}\n\n`;
    md += `## 📊 Executive Summary\n\n`;
    md += `- **Total Maps Available:** ${mapInfos.length}\n`;
    md += `- **Total Regions/States Tracked:** ${totalStates.toLocaleString()}\n`;
    md += `- **Label Support Coverage:** ${labelCoverage}% (${withLabels.length} out of ${mapInfos.length} maps)\n`;
    md += `- **Capital Coverage:** ${capitalCoverage}% (${withCapitals.length} out of ${mapInfos.length} maps)\n\n`;
    md += `---\n\n`;
    md += `## ℹ️ About this Report\n`;
    md += `This report provides an automated, real-time overview of all available map configurations located in the \`${path.relative(process.cwd(), MAPS_DIR)}\` directory.\n\n`;
    md += `- **Command**: The identifier used to reference or add the map.\n`;
    md += `- **Country Name**: The human-readable name of the map.\n`;
    md += `- **Code**: The standard short code assigned to the map.\n`;
    md += `- **Regions/States**: The total number of state/province objects defined.\n`;
    md += `- **Has Labels**: Indicates whether coordinate labels are defined for text placement.\n`;
    md += `- **Has Capitals**: Indicates whether a \`capitals\` property is defined for the map.\n\n`;
    md += `## 🗺️ Map Details\n\n`;
    md += `| Command | Country Name | Code | Regions/States | Has Labels | Has Capitals |\n`;
    md += `|---------|--------------|------|----------------|------------|--------------|\n`;

    for (const info of mapInfos) {
      md += `| \`${info.command}\` | ${info.mapName} | ${info.mapCode} | ${info.stateCount.toLocaleString()} | ${info.hasLabels === "Yes" ? "✅ Yes" : "❌ No"} | ${info.hasCapitals === "Yes" ? "✅ Yes" : "❌ No"} |\n`;
    }

    md += `\n## 📝 Notes on Label Support\n\n`;
    if (withoutLabels.length > 0) {
      md += `Some maps currently do not support the \`showLabel\` feature. This is due to a lack of available open-source coordinate data, or because we are still manually verifying label placements to ensure accuracy.\n\n`;
      md += `**Maps pending label support:**\n`;
      md +=
        withoutLabels
          .map((info) => `- \`${info.command}\` (${info.mapName})`)
          .join("\n") + "\n";
    } else {
      md += `🎉 **Great news!** All maps currently support label placement.\n`;
    }

    // ── NEW: Maps without defined capitals ─────────────────
    // Only append this section if at least one map is missing capitals.
    if (withoutCapitals.length > 0) {
      md += `\n## 💰 Notes on Capital Coverage\n\n`;
      md += `The following maps do not yet have a \`capitals\` property defined. `;
      md += `This means their capital city marker(s) cannot be rendered on the map.\n\n`;
      md += `**Maps without defined capitals:**\n\n`;
      md += withoutCapitals
        .map((info) => `- \`${info.command}\` (${info.mapName})`)
        .join("\n");
      md += `\n\n**Total without capitals:** ${withoutCapitals.length} out of ${mapInfos.length}\n`;
    }

    fs.writeFileSync(OUTPUT_FILE, md, "utf8");
    console.log(
      `\n✅ Successfully generated high-quality report: ${OUTPUT_FILE}`,
    );
    console.log(
      `📊 Processed ${mapInfos.length} map(s) | ${totalStates.toLocaleString()} total regions | ` +
        `${labelCoverage}% label coverage | ${capitalCoverage}% capital coverage.`,
    );
    if (withoutCapitals.length > 0) {
      console.log(`💰 Maps without capitals: ${withoutCapitals.length}`);
    }
  } catch (error) {
    console.error("❌ Error generating map info:", error);
    process.exit(1);
  }
}

main();
