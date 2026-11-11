// cloudflare/lib/live.mjs —— 兼容入口。
// 实现已移到 functions/lib/live.mjs（Cloudflare Pages 打包 Functions 时要求相对导入在 functions/ 内可解析）。
// 这里保留 re-export，方便 Node 脚本/单测按原路径引用。
export * from '../../functions/lib/live.mjs';
