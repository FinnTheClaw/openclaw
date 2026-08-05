import path from "node:path";
import { runMemoryScaleCertification } from "../scale-certification.js";

type Options = {
  facts: number;
  queries: number;
  directory?: string;
  output?: string;
  keep: boolean;
};

function parseOptions(): Options {
  const args = process.argv.slice(2);
  const read = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const facts = Number(read("--facts") ?? 25_000);
  const queries = Number(read("--queries") ?? 200);
  if (!Number.isInteger(facts) || facts < 1_000 || facts > 2_000_000) {
    throw new Error("--facts must be an integer between 1000 and 2000000");
  }
  if (!Number.isInteger(queries) || queries < 1 || queries > 10_000) {
    throw new Error("--queries must be an integer between 1 and 10000");
  }
  return {
    facts,
    queries,
    directory: read("--directory"),
    output: read("--output"),
    keep: args.includes("--keep"),
  };
}

async function main() {
  const options = parseOptions();
  const report = await runMemoryScaleCertification({
    facts: options.facts,
    queries: options.queries,
    directory: options.directory ? path.resolve(options.directory) : undefined,
    keep: options.keep,
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.resolve(options.output), serialized, "utf8");
  }
  process.stdout.write(serialized);
  if (report.status !== "PASS") {
    process.exitCode = 1;
  }
}

await main();
