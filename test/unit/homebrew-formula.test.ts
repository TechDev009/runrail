import { expect, test } from "bun:test"
import { homebrewFormula } from "../../scripts/homebrew-formula.ts"
import { BINARY_TARGETS, archiveName } from "../../scripts/build-binaries.ts"

const sum = (digit: string): string => digit.repeat(64)
const SUMS = [
  `${sum("1")}  runrail-0.1.2-darwin-arm64.tar.gz`,
  `${sum("2")}  runrail-0.1.2-darwin-x64.tar.gz`,
  `${sum("3")} *runrail-0.1.2-linux-arm64.tar.gz`,
  `${sum("4")}  runrail-0.1.2-linux-x64.tar.gz`,
  `${sum("5")}  runrail-0.1.2-windows-x64.zip`,
  `${sum("6")}  runrail-0.1.2.tgz`,
].join("\n")

test("the formula names each platform's archive and checksum for the release", () => {
  const formula = homebrewFormula("0.1.2", SUMS)
  expect(formula).toContain('url "https://github.com/TechDev009/runrail/releases/download/v0.1.2/runrail-0.1.2-darwin-arm64.tar.gz"\n      sha256 "' + sum("1") + '"')
  expect(formula).toContain('runrail-0.1.2-linux-arm64.tar.gz"\n      sha256 "' + sum("3") + '"')
  expect(formula).toContain('runrail-0.1.2-linux-x64.tar.gz"\n      sha256 "' + sum("4") + '"')
  expect(formula).not.toContain("windows")
})

test("a missing archive or a prerelease gets no formula", () => {
  expect(() => homebrewFormula("0.1.2", SUMS.replace("linux-x64", "linux-x86"))).toThrow("no runrail-0.1.2-linux-x64.tar.gz")
  expect(() => homebrewFormula("0.2.0-rc.1", SUMS)).toThrow("prereleases get no formula")
  expect(() => homebrewFormula('0.1.2"; system "x', SUMS)).toThrow("is not a release version")
})

test("the formula's archives are the ones the release builds", () => {
  const built = BINARY_TARGETS.filter((target) => !target.windows).map((target) => archiveName("0.1.2", target))
  for (const name of built) expect(homebrewFormula("0.1.2", SUMS)).toContain(name)
  expect(built).toHaveLength(4)
})
