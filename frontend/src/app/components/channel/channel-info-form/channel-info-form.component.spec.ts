import { provideHttpClientTesting } from '@angular/common/http/testing';
import { appConfig } from '../../../app.config';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ChannelInfoFormComponent } from './channel-info-form.component';

describe('ChannelInfoFormComponent', () => {
  let component: ChannelInfoFormComponent;
  let fixture: ComponentFixture<ChannelInfoFormComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChannelInfoFormComponent],
      providers: [...appConfig.providers, provideHttpClientTesting()]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ChannelInfoFormComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
