import { describe, expect, it } from "vitest";
import { isTrustedUpdateRequest } from "./update-guard";

/** 浏览器实测（CDP requestWillBeSentExtraInfo）拿到的真实请求头。 */
const browserSameOrigin = {
  origin: "http://127.0.0.1:3000",
  secFetchSite: "same-origin",
  requestOrigin: "http://127.0.0.1:3000",
  host: "127.0.0.1:3000",
  hostname: "127.0.0.1",
};

describe("isTrustedUpdateRequest", () => {
  it("放行应用自己的请求（浏览器实测的那一组头）", () => {
    expect(isTrustedUpdateRequest(browserSameOrigin)).toBe(true);
    // Chrome 对同源 POST 有时不带 Origin
    expect(isTrustedUpdateRequest({ ...browserSameOrigin, origin: null })).toBe(true);
    // 非浏览器客户端（curl 等）
    expect(isTrustedUpdateRequest({ ...browserSameOrigin, origin: null, secFetchSite: null })).toBe(true);
  });

  it("即使 Next 把 request.url 规范化成 localhost，也要放行（实测踩过的 403 根因）", () => {
    // 请求打到 127.0.0.1:3000，但 url.origin 报的是 http://localhost:3000
    expect(isTrustedUpdateRequest({
      ...browserSameOrigin,
      requestOrigin: "http://localhost:3000",
      hostname: "localhost",
    })).toBe(true);
  });

  it("拦住跨站页面：来源不是本机，或有跨站标注", () => {
    expect(isTrustedUpdateRequest({ ...browserSameOrigin, origin: "https://evil.example" })).toBe(false);
    expect(isTrustedUpdateRequest({ ...browserSameOrigin, origin: "null" })).toBe(false);
    expect(isTrustedUpdateRequest({ ...browserSameOrigin, secFetchSite: "cross-site" })).toBe(false);
    expect(isTrustedUpdateRequest({ ...browserSameOrigin, secFetchSite: "same-site" })).toBe(false);
    expect(isTrustedUpdateRequest({ ...browserSameOrigin, origin: "http://127.0.0.1:8080" })).toBe(false);
    expect(isTrustedUpdateRequest({ ...browserSameOrigin, origin: "not a url" })).toBe(false);
  });

  it("只接受本机回环地址", () => {
    expect(isTrustedUpdateRequest({ ...browserSameOrigin, hostname: "192.168.1.10" })).toBe(false);
    expect(isTrustedUpdateRequest({ ...browserSameOrigin, hostname: "evil.example" })).toBe(false);
    expect(isTrustedUpdateRequest({ ...browserSameOrigin, hostname: "localhost" })).toBe(true);
  });

  it("缺少 Host 头时回退到 requestOrigin 比对", () => {
    expect(isTrustedUpdateRequest({ ...browserSameOrigin, host: null })).toBe(true);
    expect(isTrustedUpdateRequest({ ...browserSameOrigin, host: null, origin: "http://127.0.0.1:9999" })).toBe(false);
  });

  it("大小写与空白不影响判定", () => {
    expect(isTrustedUpdateRequest({
      ...browserSameOrigin,
      origin: "  HTTP://127.0.0.1:3000  ",
      secFetchSite: " Same-Origin ",
      hostname: "127.0.0.1".toUpperCase(),
    })).toBe(true);
  });
});
