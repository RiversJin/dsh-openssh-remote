// 测试前置：让整个测试进程永远不会向统计端点发心跳。
//
// 事故背景（值得写下来）：`upload.test.js` 会调用真实的 `apply()`，而 apply()
// 里有 `void sendHeartbeat(...)`，于是**跑一次 npm test 就真的往生产统计里灌
// 假装机**——线上 dsh_remote_hb_daily 里因此出现过来自 CI（linux 平台）的行，
// 看起来像"多了两个 Linux 用户"。统计数据的可信度一旦被自己污染就很难解释，
// 所以这里在**任何测试加载业务代码之前**把端点指向一个必定失败的本地地址。
//
// 这是"测试不得产生外部副作用"的守门人，不是可选的便利设施。

process.env.DSH_REMOTE_HEARTBEAT_URL = 'https://127.0.0.1:9/heartbeat-disabled-in-tests'
