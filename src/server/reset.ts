import { closeDb, openDb } from '../data/db.js';
import { clearAllRuns } from '../data/repo.js';

const db = openDb(process.env.DB_PATH ?? 'data/bench.sqlite');
clearAllRuns(db);
closeDb();
console.log('数据库已清空（运行记录与候选/原始点云均已删除）。');
