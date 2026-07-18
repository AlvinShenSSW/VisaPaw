/*
 * Step 1 填写申请信息（#9）——严格按 mockups/01-input-form.html：
 * 三步指示器、国籍/院校 combobox（本地模糊搜索）、学生类型下拉、隐私说明、生成按钮。
 * 下拉数据经 IPC 取自 fetcher Termstore 缓存；provider 链取自 settings（#9 决议）。
 */

import { useEffect, useState } from 'react';
import type { Settings, TermItem } from '../../common/types.ts';
import { Combobox } from '../components/Combobox.tsx';

export const STUDENT_TYPES: ReadonlyArray<readonly [string, string]> = [
  ['01', '普通学生（默认） — 代码 01'],
  ['02', '中学交换学生 — 代码 02'],
  ['03', 'PhD 论文评审续签 — 代码 03'],
  ['04', 'DFAT 资助学生 — 代码 04'],
  ['05', '国防部资助学生 — 代码 05'],
] as const;

export interface Step1Selection {
  country: TermItem;
  school: TermItem | 'undecided';
  studentTypeCode: string;
}

export interface Step1Props {
  settings: Settings | null;
  onGenerate(selection: Step1Selection): void;
}

export function Step1(props: Step1Props): React.JSX.Element {
  const [countries, setCountries] = useState<TermItem[]>([]);
  const [schools, setSchools] = useState<TermItem[]>([]);
  const [termsError, setTermsError] = useState<string | null>(null);
  const [country, setCountry] = useState<TermItem | 'undecided' | null>(null);
  const [school, setSchool] = useState<TermItem | 'undecided' | null>(null);
  const [studentType, setStudentType] = useState(props.settings?.studentTypeDefault ?? '01');

  // 下拉数据加载失败必须显性化并可重试——静默空列表会让表单无声失效（Codex 外门 P2）
  const loadTerms = (): void => {
    setTermsError(null);
    Promise.all([
      window.visapaw?.getTerms('countries') ?? Promise.resolve([]),
      window.visapaw?.getTerms('cricos') ?? Promise.resolve([]),
    ])
      .then(([c, s]) => {
        setCountries(c);
        setSchools(s);
        setTermsError(null); // 并发加载下成功必须清除横幅（Kimi 终审 P2）
      })
      .catch((e: Error) => {
        setTermsError(e.message || '官网下拉数据加载失败');
      });
  };

  useEffect(loadTerms, []);

  useEffect(() => {
    if (props.settings) setStudentType(props.settings.studentTypeDefault);
  }, [props.settings]);

  const valid = country !== null && country !== 'undecided' && school !== null;

  return (
    <div className="content">
      <div className="hero">
        <h1>
          <span className="paw">澳洲学生签证（Subclass 500）</span>材料清单生成
        </h1>
        <p>实时检索移民局官网 Document Checklist Tool，自动翻译、分类并注入合规备注。</p>
      </div>

      <div className="stepper">
        <div className="sstep current">
          <span className="n">1</span>填写申请信息
        </div>
        <div className="sline" />
        <div className="sstep">
          <span className="n">2</span>生成清单
        </div>
        <div className="sline" />
        <div className="sstep">
          <span className="n">3</span>查看结果
        </div>
      </div>

      <div className="form">
        {termsError && (
          <div className="terms-error">
            <span>⚠️ 官网下拉数据加载失败：{termsError}</span>
            <button className="retry-link" onClick={loadTerms}>
              重试
            </button>
          </div>
        )}
        <div className="field">
          <label>
            护照国籍 <span className="opt">Country of passport · 可下拉选择，也可输入搜索</span>
          </label>
          <Combobox
            options={countries}
            placeholder="选择或搜索国家 / 地区…"
            metaText="本地模糊搜索 · 官网国家列表（缓存 7 天）"
            selected={country}
            onSelect={setCountry}
            icon="🌏"
          />
        </div>

        <div className="field">
          <label>
            意向院校 <span className="opt">Education provider · 可下拉选择，也可直接输入名称或 CRICOS 码</span>
          </label>
          <Combobox
            options={schools}
            placeholder="选择或搜索院校名称 / CRICOS 码…"
            metaText="本地模糊搜索 · 官网 CRICOS 院校列表（缓存 7 天）"
            selected={school}
            onSelect={setSchool}
            undecidedLabel="未定（尚未确定院校，按「未列出院校」判定清单类型）"
            icon="🎓"
          />
        </div>

        <div className="field">
          <label>
            学生类型 <span className="opt">Student type</span>
          </label>
          <select className="select" value={studentType} onChange={(e) => setStudentType(e.target.value)}>
            {STUDENT_TYPES.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className="actions">
          <div className="privacy">
            <span className="lock">🔒</span> 三个选项与官网 Document Checklist Tool
            一一对应；抓取由本机直连官网完成，不经任何云端代理，不涉及个人身份信息。
          </div>
          <button
            className="btn-primary"
            disabled={!valid}
            onClick={() => {
              if (valid) {
                props.onGenerate({
                  country: country as TermItem,
                  school: school as TermItem | 'undecided',
                  studentTypeCode: studentType,
                });
              }
            }}
          >
            生成清单 →
          </button>
        </div>
      </div>
    </div>
  );
}
