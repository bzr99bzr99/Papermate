import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
  // 注意：standalone 会顺带复制代码里 path.join(process.cwd(), ...) 命中的文件，
  // 本机构建时 data/（明文 API Key + 论文库）与 .git/ 也会被复制进 .next/standalone。
  // 实测 outputFileTracingExcludes 拦不住这一步（Next 15.5 / Windows），所以不要在
  // 这里加无效配置：唯一可靠的关卡是 scripts/package-update.mjs —— 它先删除这些目录，
  // 再用硬断言确认发布包里绝不含 data/、.git/、.env*、apikey.txt、papermate.db。
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;
