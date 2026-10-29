import './parameter-sheet.css';

interface NativeParameterRow {
  label: string;
  id: string;
  min: number;
  max: number;
  step: number;
  value: number;
  outputId?: string;
  displayValue?: string;
  rangeId?: string;
  unit?: string;
}

function parameterRow({ label, id, min, max, step, value, outputId, displayValue, rangeId, unit }: NativeParameterRow): string {
  const sliderId = rangeId ?? id;
  const progress = (value - min) / (max - min) * 100;
  const valueMarkup = outputId
    ? `<output class="native-parameter-value" id="${outputId}" for="${id}">${displayValue ?? value}</output>`
    : `<span class="native-parameter-number"><input class="native-parameter-value native-number-value" id="${id}" type="number" min="${min}" max="${max}" step="${step}" value="${displayValue ?? value}" inputmode="numeric" aria-label="${label}">${unit ? `<span class="native-parameter-unit">${unit}</span>` : ''}</span>`;

  return `<div class="native-control-row">
    <div class="native-control-heading"><label for="${id}">${label}</label>${valueMarkup}</div>
    <div class="native-control-adjusters">
      <input class="native-parameter-range" id="${sliderId}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" style="--native-range-progress:${progress}%" aria-label="${label}">
      <div class="native-parameter-stepper" role="group" aria-label="Adjust ${label}">
        <button type="button" data-step-target="${id}" data-step-delta="${-step}" aria-label="Decrease ${label}"><span aria-hidden="true">−</span></button>
        <button type="button" data-step-target="${id}" data-step-delta="${step}" aria-label="Increase ${label}"><span aria-hidden="true">+</span></button>
      </div>
    </div>
  </div>`;
}

/** Native Parameters contents. The application owns state, navigation, and events. */
export function parameterSheetMarkup(): string {
  return `<div class="native-parameters">
    <button class="native-parameter-back" id="parameter-back" type="button" hidden><span class="native-back-chevron" aria-hidden="true"></span>Parameters</button>
    <div class="native-parameter-home" id="parameter-home">
      <div class="native-parameter-group">
        ${parameterRow({ label: 'Master Volume', id: 'master-gain', min: 0, max: 2, step: 0.01, value: 0.7, outputId: 'master-gain-value', displayValue: '70.00' })}
        ${parameterRow({ label: 'Master Balance', id: 'master-balance', min: -1, max: 1, step: 0.01, value: 0, outputId: 'master-balance-value', displayValue: '0.00' })}
        ${parameterRow({ label: 'Master Key Shift', id: 'key-shift', rangeId: 'key-shift-range', min: -48, max: 48, step: 1, value: 0 })}
        ${parameterRow({ label: 'Master Tune', id: 'fine-tune', rangeId: 'fine-tune-range', min: -100, max: 100, step: 1, value: 0, displayValue: '0.00', unit: 'cent' })}
        <button class="native-parameter-link" id="parameter-tuning-open" type="button"><span>Part Tuning</span><span class="native-parameter-chevron" aria-hidden="true"></span></button>
        <button class="native-parameter-link" id="parameter-extras-open" type="button"><span>Miscellaneous Parameters</span><span class="native-parameter-chevron" aria-hidden="true"></span></button>
      </div>
      <section class="native-effect-section" aria-labelledby="native-reverb-heading">
        <h2 class="native-parameter-section-heading" id="native-reverb-heading">Reverb</h2>
        <div class="native-parameter-group">${parameterRow({ label: 'Level', id: 'reverb-gain', min: 0, max: 2, step: 0.01, value: 0, outputId: 'reverb-gain-value', displayValue: '0.00 %' })}</div>
      </section>
      <section class="native-effect-section" aria-labelledby="native-chorus-heading">
        <h2 class="native-parameter-section-heading" id="native-chorus-heading">Chorus</h2>
        <div class="native-parameter-group">${parameterRow({ label: 'Level', id: 'chorus-gain', min: 0, max: 2, step: 0.01, value: 0, outputId: 'chorus-gain-value', displayValue: '0.00 %' })}</div>
      </section>
    </div>
    <div class="native-parameter-subpage" id="parameter-tuning" hidden></div>
    <div class="native-parameter-subpage" id="parameter-extras" hidden></div>
  </div>`;
}
