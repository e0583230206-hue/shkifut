import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PrivilegDashboardComponent } from './privileg-dashboard.component';

describe('PrivilegDashboardComponent', () => {
  let component: PrivilegDashboardComponent;
  let fixture: ComponentFixture<PrivilegDashboardComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PrivilegDashboardComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(PrivilegDashboardComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
