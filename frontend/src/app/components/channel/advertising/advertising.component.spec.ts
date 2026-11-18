import { provideHttpClientTesting } from '@angular/common/http/testing';
import { appConfig } from '../../../app.config';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AdvertisingComponent } from './advertising.component';

describe('AdvertisingComponent', () => {
  let component: AdvertisingComponent;
  let fixture: ComponentFixture<AdvertisingComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdvertisingComponent],
      providers: [...appConfig.providers, provideHttpClientTesting()]
    })
    .compileComponents();

    fixture = TestBed.createComponent(AdvertisingComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
