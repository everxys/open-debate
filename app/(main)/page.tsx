import Link from "next/link";

export default function HomePage() {
  return (
    <div className="grid" style={{ gap: 20 }}>
      <section className="panel stack">
        <h1 style={{ margin: 0 }}>V1 代码骨架已生成</h1>
        <p className="muted" style={{ margin: 0 }}>
          当前版本已切换为 Docker Compose + Next.js + Postgres，覆盖 AI 配置管理、创建辩论、启动/暂停/恢复/停止、轮次执行和详情查看。
        </p>
        <div className="row">
          <Link className="btn btn-primary" href="/agents">
            先创建 AI 配置
          </Link>
          <Link className="btn" href="/debates">
            查看辩论
          </Link>
        </div>
      </section>

      <section className="panel stack">
        <h2 style={{ margin: 0 }}>运行方式</h2>
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          <li>直接执行：`docker compose up --build`</li>
          <li>Postgres 会自动执行初始化脚本建表</li>
          <li>访问 `http://localhost:3000` 注册账号并开始使用</li>
        </ol>
      </section>
    </div>
  );
}

