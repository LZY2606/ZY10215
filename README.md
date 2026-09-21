# 轮缘磨耗对谱台（Flange Wear Bench）

把同一轮位、多期采集的轮缘/踏面二维轮廓与标准廓形对齐，计算**法向磨耗厚度**，
并与**标准限界**求交集，在本地页面并排显示各期廓形、刚体对齐与对齐残差。
TypeScript + Node.js + SQLite + Canvas，零外部数据、可完全离线重放。

## 安装与运行

```bash
corepack pnpm install --frozen-lockfile

# 自动化测试（含验收夹具的全部不变量）
corepack pnpm test -- --run

# 本地服务 + 操作页面
corepack pnpm dev -- --host 127.0.0.1 --port 5555
# 访问 http://127.0.0.1:5555 ，页首标题为“轮缘磨耗对谱台”
```

`pnpm dev` 用 Vite 中间件提供同源 API；数据库文件位于 `data/flange-bench.sqlite`
（首次运行自动创建，使用 Node 内置 `node:sqlite`，无需原生编译）。

## 数据口径（重要）

### 点序与转向

- 所有轮廓点序按**实际弧长**重建：弧长 = 相邻采样点欧氏距离的累加
  （`buildPolyline`），**绝不按 x/y 坐标排序**。
- canonical 方向为 `flange-face → flange-tip → flange-root → tread`。
- 输入转向相反时，规范化模块对整条点序做**显式语义翻转**
  （`reversePolyline` 整体逆序），并在结果 `flipped=true` 留痕；
  判向依据是旋转/平移不变的曲率签名（root R14 圆弧所在弧长侧），
  与导入顺序、坐标大小无关。

### 截断段

- 轮廓被截短时只报告相对标准廓形的**弧长缺口**（`missingStartS` /
  `missingEndS`），标准廓形之外的测量点标记为 `beyondStandard`，
  其法向磨耗为 `NaN`——**不用端点平移或外推填满截断段**。

### 刚体配准

- 默认口径为 **root 锦标锁定（lockRoot）**：用轮缘根部 R14 圆弧的
  圆心定平移、中角定旋转；磨耗是待测量信号，不参与刚体求解，
  因此不会把配准“拖向”磨耗后的形状。
- 共享测头偏差用“固定标称半径 R14 的鲁棒圆心/半径扫描 + root 锦标”估计，
  root 上的轻微浅凹/毛刺按离群点排除。
- 用户可选择基准段（全段 / 踏面 / root / tip）、是否锁定锦标、
  近同分阈值，以及按条轮廓排除污点弧长区间。
- 多起点对齐后候选**只按分数排序**；与最优分相对差不超过阈值的候选
  一律 `retained`，每个候选都带 `provenance`（起点来源）可追溯，
  **不以导入顺序决定结论**。

### 法向磨耗与限界

- 标准表面 canonical 点序的外侧（空气侧）单位法向记为 `n`；
  `wear = -(p - q)·n`，为正表示材料被磨去。
- 限界按语义段给 `warning / critical` 两级；超限连续段沿标准弧长聚类，
  每条违规携带**限界版本号**（`limitVersion`，当前 `STD-WP-1.0`）。
- 测头偏差：可以“应用共享候选到整批”，每条轮廓仍有独立开关
  （使用共享偏差 / 自身独立估计 / 独立选择候选）。

### 结果指纹

每次对谱产生 SHA-256 指纹，进入哈希的内容包括：

- 标准廓形/限界**版本号**与各级阈值；
- 基准段、root-lock、近同分阈值、排除区间；
- 每条轮廓的翻转标记、截断缺口、点数、弧长；
- 选定候选序号、保留候选集合、刚体变换、测头偏差来源与数值、残差 RMS；
- 超限段（段、级别、峰值、限界版本）。

改变其中任何一项（包括限界版本）都会改变指纹。

## 固定 Fixture（可重放、无随机数）

`src/core/fixtures.ts` 由标准廓形确定性派生三轮位 `1A-L` 数据：

| ID | 期次 | 方向 | 特征 |
|----|------|------|------|
| `1A-L#1` | 2026-08-01 | forward 正向 | 踏面局部磨耗（约 2.3mm，未超限） |
| `1A-L#2` | 2026-09-01 | reverse 反向 | 点序显式逆序采集，踏面磨耗发展（超 warning） |
| `1A-L#3` | 2026-09-20 | forward 截短 | 截去 face 下部与踏面尾端、踏面超 critical、含污点；root 双浅凹造成两个近同分对齐候选 |

三期共享同一测头偏差 +0.30mm。验收可直接检查：

- `#2` 规范化后 `flipped===true`，且这是**语义翻转**（逆序）而非坐标排序；
- `#3` 截短缺口存在，且 beyond-standard 样本不被端点填充；
- `#3` 对齐保留两个 `retained` 候选（锦标解与切向滑动解，分差 ≤5%），
  二者均带 `provenance`，可独立选择。

## 运行记录导出 / 清空 / 重新导入复核

- 页面“导出运行记录”（或 `GET /api/export`）下载包含
  标准廓形、原始轮廓、全部运行记录（含指纹）的 JSON 包。
- “清空数据库”（或 `POST /api/admin/clear`）删除全部轮廓与运行记录。
- “导入复核”（或 `POST /api/import`）回灌导出包；同口径重新对谱
  （`POST /api/analyze`）会得到**相同指纹**，用于复核。

## 主要 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/fixtures` | 固定 fixture（标准 + 三期轮廓） |
| POST | `/api/profiles/load-fixtures` | 把 fixture 写入 SQLite |
| GET/POST | `/api/profiles` | 列表 / 导入轮廓 |
| POST | `/api/analyze` | 对谱（body 可覆盖基准、lockRoot、阈值、逐条配置） |
| GET  | `/api/runs` / `/api/runs/:id` | 运行记录列表 / 详情 |
| GET  | `/api/export` | 完整导出包 |
| POST | `/api/import` | 重新导入复核 |
| POST | `/api/admin/clear` | 清空数据库 |

## 目录

```
src/core/      几何、标准廓形、规范化（翻转/截断）、root 锦标补偿、
               多候选对齐、法向磨耗、限界、批次流水线与指纹、固定 fixture
src/web/       Canvas 渲染与操作页面
server/        node:sqlite 持久化、Vite API 中间件、序列化
test/          Vitest 自动化测试（几何/翻转/截断/对齐/磨耗/限界/指纹/存储）
data/          SQLite 数据库（运行时生成）
```
