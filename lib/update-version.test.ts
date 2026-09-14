import { describe, expect, it } from "vitest";
import {
  UPDATE_ASSET,
  htmlToPlainText,
  isNewerVersion,
  latestReleasePageUrl,
  newestFromAtom,
  parseReleaseTagFromUrl,
  parseReleasesAtom,
  parseVersion,
  releasesAtomUrl,
  trustedAsset,
} from "./update-version";

describe("parseVersion", () => {
  it("接受三段、两段与一段版本号（历史 Release 用的是 v3.6 这种两段 tag）", () => {
    expect(parseVersion("v3.6")).toEqual([3, 6, 0]);
    expect(parseVersion("3.6.1")).toEqual([3, 6, 1]);
    expect(parseVersion("v3")).toEqual([3, 0, 0]);
    expect(parseVersion("  v10.20.30  ")).toEqual([10, 20, 30]);
    expect(parseVersion("0.1.0")).toEqual([0, 1, 0]);
  });

  it("拒绝非法写法", () => {
    expect(parseVersion("")).toBeUndefined();
    expect(parseVersion("nightly")).toBeUndefined();
    expect(parseVersion("v3.6.0.1")).toBeUndefined();
    expect(parseVersion("v03.6")).toBeUndefined();
    expect(parseVersion("v3.6-beta")).toBeUndefined();
    expect(parseVersion("3.6.0-rc1")).toBeUndefined();
    expect(parseVersion("release-3.6")).toBeUndefined();
  });
});

describe("isNewerVersion", () => {
  it("按三段数值比较，缺失段视为 0", () => {
    expect(isNewerVersion("v3.7", "3.6.0")).toBe(true);
    expect(isNewerVersion("v3.6.1", "3.6.0")).toBe(true);
    expect(isNewerVersion("v4", "3.6.9")).toBe(true);
    expect(isNewerVersion("v3.6", "3.6.0")).toBe(false);
    expect(isNewerVersion("v3.5", "3.6.0")).toBe(false);
    expect(isNewerVersion("v0.1.0", "3.6.0")).toBe(false);
  });

  it("用仓库真实发布过的 tag 回归：早先只认三段版本号，v3.6 会直接报“格式不受支持”", () => {
    const published = ["v3.6", "v3.3", "v3.2", "v3.1", "v3.0.1", "v3.0", "v2.9", "v2.8", "v2.1"];
    for (const tag of published) {
      expect(parseVersion(tag), tag).toBeDefined();
      // 相对当前源码版本（3.7.0）都是旧版本 ⇒ 不应提示更新
      expect(isNewerVersion(tag, "3.7.0"), tag).toBe(false);
      // 相对旧安装版本（0.1.0）都算新版本 ⇒ 应该提示更新
      expect(isNewerVersion(tag, "0.1.0"), tag).toBe(true);
    }
  });

  it("任一侧无法解析时一律返回 false（宁可不提示，也不误报新版）", () => {
    expect(isNewerVersion("bad", "3.6.0")).toBe(false);
    expect(isNewerVersion("v9.9.9", "bad")).toBe(false);
    expect(isNewerVersion("v9.9.9", "")).toBe(false);
  });
});

describe("trustedAsset", () => {
  it("接受本仓库正式 Release 的 https 直链（含改名前的旧仓库名）", () => {
    expect(trustedAsset(`https://github.com/bzr99bzr99/Papermatev1.0/releases/download/v3.7.0/${UPDATE_ASSET}`)).toBe(true);
    // 仓库改名后 GitHub 返回的规范名
    expect(trustedAsset(`https://github.com/bzr99bzr99/Papermate/releases/download/v3.7.0/${UPDATE_ASSET}`)).toBe(true);
    expect(trustedAsset(`https://github.com/BZR99BZR99/papermate/releases/download/v3.7.0/${UPDATE_ASSET}`)).toBe(true);
  });

  it("拒绝第三方、明文协议与其他仓库", () => {
    expect(trustedAsset(`https://example.com/bzr99bzr99/Papermate/releases/download/v1/${UPDATE_ASSET}`)).toBe(false);
    expect(trustedAsset(`http://github.com/bzr99bzr99/Papermate/releases/download/v1/${UPDATE_ASSET}`)).toBe(false);
    expect(trustedAsset(`https://github.com/attacker/repo/releases/download/v1/${UPDATE_ASSET}`)).toBe(false);
    expect(trustedAsset(`https://github.com/bzr99bzr99/Papermate/archive/refs/tags/v3.6.zip`)).toBe(false);
    expect(trustedAsset("not a url")).toBe(false);
    expect(trustedAsset("")).toBe(false);
  });
});

describe("不走 API 的版本发现", () => {
  it("从 /releases/latest 跳转后的最终 URL 读出 tag", () => {
    expect(parseReleaseTagFromUrl("https://github.com/bzr99bzr99/Papermate/releases/tag/v3.6")).toBe("v3.6");
    expect(parseReleaseTagFromUrl("https://github.com/bzr99bzr99/Papermate/releases/tag/3.0.1")).toBe("3.0.1");
    expect(parseReleaseTagFromUrl("https://github.com/bzr99bzr99/Papermate/releases/tag/v3.7.0-rc1")).toBe("v3.7.0-rc1");
    // 还没发布任何正式版时 GitHub 会停在 /releases
    expect(parseReleaseTagFromUrl("https://github.com/bzr99bzr99/Papermate/releases")).toBeUndefined();
    expect(parseReleaseTagFromUrl("https://github.com/bzr99bzr99/Papermate")).toBeUndefined();
    expect(parseReleaseTagFromUrl("not a url")).toBeUndefined();
  });

  it("使用 github.com 的普通网页路径（不受未登录 API 60 次/小时限制）", () => {
    expect(latestReleasePageUrl()).toBe("https://github.com/bzr99bzr99/Papermatev1.0/releases/latest");
    expect(releasesAtomUrl()).toBe("https://github.com/bzr99bzr99/Papermatev1.0/releases.atom");
    expect(latestReleasePageUrl("a/b")).not.toContain("api.github.com");
  });

  it("把 Atom 里的 HTML 说明转成可读纯文本", () => {
    const html = "&lt;h1&gt;PaperMate v3.6 正式版&lt;/h1&gt;\n&lt;h2&gt;✨ 更新内容&lt;/h2&gt;\n&lt;ul&gt;\n&lt;li&gt;新增&lt;code&gt;visual-refresh.css&lt;/code&gt;&lt;/li&gt;\n&lt;li&gt;修复 &amp; 优化&lt;/li&gt;\n&lt;/ul&gt;";
    const text = htmlToPlainText(html);
    expect(text).toContain("PaperMate v3.6 正式版");
    expect(text).toContain("- 新增visual-refresh.css");
    expect(text).toContain("- 修复 & 优化");
    expect(text).not.toContain("<");
    expect(text).not.toContain("&lt;");
    expect(text).not.toContain("\n\n\n");
  });

  it("解析订阅源条目：tag、标题、日期与说明", () => {
    const feed = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">
 <entry>
  <link rel="alternate" type="text/html" href="https://github.com/bzr99bzr99/Papermate/releases/tag/v3.6"/>
  <title>PaperMate v3.6 正式版</title>
  <updated>2026-09-08T11:16:08Z</updated>
  <content type="html">&lt;p&gt;界面视觉刷新&lt;/p&gt;</content>
 </entry>
 <entry>
  <link rel="alternate" type="text/html" href="https://github.com/bzr99bzr99/Papermate/releases/tag/v3.3"/>
  <title>PaperMate v3.3 正式版</title>
  <updated>2026-08-25T17:22:14Z</updated>
  <content type="html">&lt;p&gt;阅读器新交互&lt;/p&gt;</content>
 </entry>
</feed>`;
    const releases = parseReleasesAtom(feed);
    expect(releases).toHaveLength(2);
    expect(releases[0]).toMatchObject({ tag: "v3.6", title: "PaperMate v3.6 正式版" });
    expect(releases[0].publishedAt).toBe("2026-09-08T11:16:08Z");
    expect(releases[0].notes).toBe("界面视觉刷新");
    expect(releases[0].url).toContain("/releases/tag/v3.6");
  });

  it("挑版本号最大的条目：订阅源按时间排序，补丁版本可能排在最前", () => {
    const feed = `<?xml version="1.0"?><feed>
 <entry><link href="https://github.com/a/b/releases/tag/v3.2.1"/><title>补丁</title><content>&lt;p&gt;p&lt;/p&gt;</content></entry>
 <entry><link href="https://github.com/a/b/releases/tag/v3.6"/><title>主线</title><content>&lt;p&gt;m&lt;/p&gt;</content></entry>
 <entry><link href="https://github.com/a/b/releases/tag/nightly"/><title>无效</title><content>&lt;p&gt;x&lt;/p&gt;</content></entry>
</feed>`;
    expect(newestFromAtom(feed)?.tag).toBe("v3.6");
    expect(newestFromAtom("<feed></feed>")).toBeUndefined();
  });
});
