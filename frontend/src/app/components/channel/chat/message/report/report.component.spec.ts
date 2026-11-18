import { provideHttpClientTesting } from '@angular/common/http/testing';
import { appConfig } from '../../../../../app.config';
import { NbDialogRef } from '@nebular/theme';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ReportComponent } from './report.component';

describe('ReportComponent', () => {
  let component: ReportComponent;
  let fixture: ComponentFixture<ReportComponent>;
  // The report dialog is opened with the message id in its context: the component reads it from the dialog's instance.
  const dialogRef = { componentRef: { instance: { messageId: 42 } }, close: jasmine.createSpy('close') };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ReportComponent],
      providers: [...appConfig.providers, provideHttpClientTesting(), { provide: NbDialogRef, useValue: dialogRef }]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ReportComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('takes the message id from the dialog context', () => {
    expect(component.messageId).toBe(42);
  });
});
