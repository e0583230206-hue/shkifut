import { provideHttpClientTesting } from '@angular/common/http/testing';
import { appConfig } from '../../../app.config';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { EmojisComponent } from './emojis.component';

describe('EmojisComponent', () => {
  let component: EmojisComponent;
  let fixture: ComponentFixture<EmojisComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [EmojisComponent],
      providers: [...appConfig.providers, provideHttpClientTesting()]
    })
    .compileComponents();

    fixture = TestBed.createComponent(EmojisComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
