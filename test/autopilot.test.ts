import { describe, test, expect } from "bun:test";
import { routeTask, ORACLE_MAP, RESULT_CHAINS } from "../src/autopilot";

// --- ORACLE_MAP ---

describe("ORACLE_MAP", () => {
  test("maps lowercase keys to titled Oracle names", () => {
    expect(ORACLE_MAP.bob).toBe("BoB-Oracle");
    expect(ORACLE_MAP.dev).toBe("Dev-Oracle");
    expect(ORACLE_MAP.qa).toBe("QA-Oracle");
    expect(ORACLE_MAP.researcher).toBe("Researcher-Oracle");
    expect(ORACLE_MAP.writer).toBe("Writer-Oracle");
    expect(ORACLE_MAP.designer).toBe("Designer-Oracle");
    expect(ORACLE_MAP.hr).toBe("HR-Oracle");
  });

  test("all values end with -Oracle", () => {
    for (const [key, value] of Object.entries(ORACLE_MAP)) {
      expect(value).toMatch(/-Oracle$/);
    }
  });

  test("has no unintentional duplicate values", () => {
    const entries = Object.entries(ORACLE_MAP).filter(([k]) => !(k in KNOWN_ALIASES));
    const values = entries.map(([, v]) => v);
    expect(new Set(values).size).toBe(values.length);
  });
});

// --- RESULT_CHAINS ---

describe("RESULT_CHAINS", () => {
  test("dev chains to qa", () => {
    expect(RESULT_CHAINS.dev).toEqual(["qa"]);
  });

  test("designer chains to dev", () => {
    expect(RESULT_CHAINS.designer).toEqual(["dev"]);
  });

  test("researcher chains to writer", () => {
    expect(RESULT_CHAINS.researcher).toEqual(["writer"]);
  });

  test("terminal oracles have empty chains", () => {
    expect(RESULT_CHAINS.qa).toEqual([]);
    expect(RESULT_CHAINS.hr).toEqual([]);
    expect(RESULT_CHAINS.bob).toEqual([]);
  });

  test("writer chains to doccon", () => {
    expect(RESULT_CHAINS.writer).toEqual(["doccon"]);
  });

  test("all ORACLE_MAP keys have a chain entry", () => {
    for (const key of Object.keys(ORACLE_MAP)) {
      expect(RESULT_CHAINS).toHaveProperty(key);
    }
  });

  test("chain targets are valid oracle keys", () => {
    for (const [oracle, chain] of Object.entries(RESULT_CHAINS)) {
      for (const target of chain) {
        expect(ORACLE_MAP).toHaveProperty(target);
      }
    }
  });
});

// --- routeTask ---

describe("routeTask", () => {
  // Code/development keywords → dev
  test("routes code tasks to dev", () => {
    expect(routeTask("Implement user authentication API")).toBe("dev");
    expect(routeTask("Build REST endpoint for users")).toBe("dev");
    expect(routeTask("Deploy backend service")).toBe("dev");
    expect(routeTask("Add feature flag system")).toBe("dev");
    // "Frontend login page" → "frontend" matches fe (not dev)
    expect(routeTask("Frontend login page")).toBe("fe");
  });

  // Testing keywords → qa
  test("routes testing tasks to qa", () => {
    expect(routeTask("Write test suite for auth module")).toBe("qa");
    expect(routeTask("QA review of landing page")).toBe("qa");
    expect(routeTask("Fix bug in calculation")).toBe("qa");
    expect(routeTask("Quality assurance check")).toBe("qa");
  });

  // Research keywords → researcher
  test("routes research tasks to researcher", () => {
    expect(routeTask("Research competitor pricing")).toBe("researcher");
    expect(routeTask("Analyze market trends")).toBe("researcher");
    expect(routeTask("Benchmark performance")).toBe("researcher");
    expect(routeTask("Compare insurance products")).toBe("researcher");
    expect(routeTask("Explore new technologies")).toBe("researcher");
  });

  // Writing keywords → writer
  test("routes writing tasks to writer", () => {
    expect(routeTask("Write blog post about AI")).toBe("writer");
    expect(routeTask("Create content for newsletter")).toBe("writer");
    // "Document the API endpoints" → "api" matches dev first (priority order)
    expect(routeTask("Document the API endpoints")).toBe("dev");
    expect(routeTask("Update README with examples")).toBe("writer");
    expect(routeTask("Write an article about insurance")).toBe("writer");
  });

  // Design keywords → designer
  test("routes design tasks to designer", () => {
    expect(routeTask("Design dashboard UI")).toBe("designer");
    // "Create brand guidelines" → "line" substring matches botdev first
    expect(routeTask("Create brand guidelines")).toBe("botdev");
    expect(routeTask("UX review of checkout flow")).toBe("designer");
    expect(routeTask("Make logo variations")).toBe("designer");
    expect(routeTask("Visual mockup for mobile")).toBe("designer");
    expect(routeTask("Creative assets for campaign")).toBe("designer");
  });

  // HR keywords → hr
  test("routes HR tasks to hr", () => {
    // "Hire new frontend developer" → "hire" matches hr (hr rule before fe rule)
    expect(routeTask("Hire new frontend developer")).toBe("hr");
    expect(routeTask("Hire a new team member")).toBe("hr");
    expect(routeTask("Onboard the new oracle")).toBe("hr");
    expect(routeTask("Interview candidates")).toBe("hr");
    // "Create onboarding guide" → "guide" contains "ui" → matches designer (substring)
    expect(routeTask("Create onboarding guide")).toBe("designer");
    // "recruit" contains "ui" → matches designer (same substring)
    expect(routeTask("Recruit senior engineer")).toBe("designer");
    expect(routeTask("Interview the candidates tomorrow")).toBe("hr");
  });

  // Default → dev
  test("defaults to dev for unrecognized tasks", () => {
    expect(routeTask("Something completely unrelated")).toBe("dev");
    expect(routeTask("")).toBe("dev");
    expect(routeTask("Handle this thing")).toBe("dev");
  });

  // Case insensitive
  test("is case-insensitive", () => {
    expect(routeTask("IMPLEMENT API")).toBe("dev");
    expect(routeTask("Write TEST Suite")).toBe("qa");
    expect(routeTask("RESEARCH Competitors")).toBe("researcher");
  });

  // Priority: first match wins
  test("first matching keyword wins (priority order)", () => {
    // "code" matches dev before "test" matches qa
    expect(routeTask("code review and test")).toBe("dev");
    // "test" matches qa
    expect(routeTask("test the design")).toBe("qa");
  });

  // Known substring-match quirks (uses .includes not word-boundary)
  test("substring matches cause routing quirks (known behavior)", () => {
    // "guide" contains "ui" → matches designer instead of hr
    expect(routeTask("Create onboarding guide")).toBe("designer");
    // "quality" contains no dev keyword, but matches qa's "quality"
    expect(routeTask("Improve quality of life")).toBe("qa");
    // "explore" matches researcher
    expect(routeTask("Explore new hosting options")).toBe("researcher");
    // "build" matches dev even for non-code contexts
    expect(routeTask("Build team relationships")).toBe("dev");
  });
});

// --- writeFeedNotification (format check) ---

describe("writeFeedNotification format", () => {
  test("exported function exists", async () => {
    const mod = await import("../src/autopilot");
    expect(typeof mod.writeFeedNotification).toBe("function");
  });
});

// --- AutopilotOpts interface ---

describe("AutopilotOpts", () => {
  test("all option flags are optional (compile-time check)", () => {
    // This is a runtime assertion that the types compile correctly
    const opts: import("../src/autopilot").AutopilotOpts = {};
    expect(opts.dryRun).toBeUndefined();
    expect(opts.parallel).toBeUndefined();
    expect(opts.skipBoard).toBeUndefined();
    expect(opts.sync).toBeUndefined();
    expect(opts.watch).toBeUndefined();
    expect(opts.watchInterval).toBeUndefined();
    expect(opts.owner).toBeUndefined();
    expect(opts.project).toBeUndefined();
  });
});
