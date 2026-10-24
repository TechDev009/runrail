import { readFile } from "node:fs/promises"

/**
 * The Homebrew formula for one release's executables, from its SHA256SUMS.txt:
 *
 *   bun scripts/homebrew-formula.ts <version> <SHA256SUMS.txt>
 *
 * publish.yml writes it to Formula/runrail.rb in the TechDev009/homebrew-runrail tap.
 */

const RELEASES = "https://github.com/TechDev009/runrail/releases/download"
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const
type Platform = (typeof PLATFORMS)[number]

/** Each platform's archive checksum, read from a `sha256sum` listing. */
export function archiveChecksums(version: string, sums: string): Readonly<Record<Platform, string>> {
  const listed = new Map<string, string>()
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim())
    if (match?.[1] !== undefined && match[2] !== undefined) listed.set(match[2], match[1])
  }
  const found: Partial<Record<Platform, string>> = {}
  for (const platform of PLATFORMS) {
    const sum = listed.get(`runrail-${version}-${platform}.tar.gz`)
    if (sum === undefined) throw new Error(`SHA256SUMS.txt has no runrail-${version}-${platform}.tar.gz`)
    found[platform] = sum
  }
  return found as Record<Platform, string>
}

export function homebrewFormula(version: string, sums: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${version} is not a release version; prereleases get no formula`)
  const sha = archiveChecksums(version, sums)
  const archive = (platform: Platform): string => `      url "${RELEASES}/v${version}/runrail-${version}-${platform}.tar.gz"\n      sha256 "${sha[platform]}"`
  return `# Written by Runrail's publish workflow for each release; edits here are replaced.
class Runrail < Formula
  desc "Local-first, verification-first harness for coding agents"
  homepage "https://github.com/TechDev009/runrail"
  license "AGPL-3.0-only"

  on_macos do
    on_arm do
${archive("darwin-arm64")}
    end
    on_intel do
${archive("darwin-x64")}
    end
  end

  on_linux do
    on_arm do
${archive("linux-arm64")}
    end
    on_intel do
${archive("linux-x64")}
    end
  end

  def install
    bin.install "runrail"
  end

  def caveats
    <<~EOS
      For Claude Code to ask before it uses a tool, Runrail needs Anthropic's Claude Agent SDK.
      This downloads it from npm, after asking you:
        runrail sdk install
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/runrail --version").strip
  end
end
`
}

if (import.meta.main) {
  const [version, sumsPath] = process.argv.slice(2)
  if (version === undefined || sumsPath === undefined) throw new Error("usage: bun scripts/homebrew-formula.ts <version> <SHA256SUMS.txt>")
  process.stdout.write(homebrewFormula(version, await readFile(sumsPath, "utf8")))
}
