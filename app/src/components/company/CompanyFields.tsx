/**
 * 模块二 · 公司五个新字段的就地编辑（COM-4）。
 *
 * 两个容易做错的地方：
 * 1. `employeeReview`（员工口碑）与既有 `impression`（面试体感）**是两个字段**，
 *    合成一个的结果是用户永远只填一种 —— 所以这里的标签也必须分开写；
 * 2. 清空 = 删键（传 undefined），不写空串 —— 否则「旧数据没有这个字段」与
 *    「用户填了空」就分不出来了（契约 4）。
 */

import type { AppApi } from '../../lib/api';
import type { Company, CompanyStage } from '../../types';
import { COMPANY_STAGES, COMPANY_STAGE_LABEL } from '../../lib/company/fields';
import { CLS } from '../../lib/classTokens';
import { Field, SelectField } from '../Field';

export interface CompanyFieldsProps {
  api: AppApi;
  company: Company;
}

export function CompanyFields({ api, company }: CompanyFieldsProps) {
  const save = (patch: Parameters<AppApi['company']['saveExtras']>[1]): void => {
    api.company.saveExtras(company.id, patch);
  };

  return (
    <div className="dossier__fields" data-testid="company-fields">
      <Field
        label="规模"
        value={company.scale ?? ''}
        onCommit={(value) => save({ scale: value.trim() || undefined })}
        placeholder="1000-9999 人"
        narrow
      />
      <SelectField<CompanyStage>
        label="融资阶段"
        value={company.financingStage ?? ''}
        options={COMPANY_STAGES.map((stage) => ({ value: stage, label: COMPANY_STAGE_LABEL[stage] }))}
        onChange={(value) => save({ financingStage: value })}
        placeholder="没填"
        narrow
      />
      <Field
        label="官网"
        value={company.website ?? ''}
        onCommit={(value) => save({ website: value.trim() || undefined })}
        placeholder="https://"
        hint="只接受 http(s) 开头的地址"
        narrow
      />
      <Field
        label="行业细分"
        value={company.industryDetail ?? ''}
        onCommit={(value) => save({ industryDetail: value.trim() || undefined })}
        placeholder="短视频 / 电商中台"
        narrow
      />
      <Field
        label="员工口碑"
        value={company.employeeReview ?? ''}
        onCommit={(value) => save({ employeeReview: value.trim() || undefined })}
        placeholder="加班多不多、涨薪快不快 —— 这是「别人说的」"
      />
      <p className={CLS.c}>
        「面试体感」是你在抽屉里记的亲身经历，「员工口碑」是外部说法 —— 两条分开记，回看时才分得清。
      </p>
    </div>
  );
}
