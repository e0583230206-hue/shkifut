import { provideHttpClientTesting } from '@angular/common/http/testing';
import { appConfig } from '../../../../app.config';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NbDialogRef } from '@nebular/theme';

import { YoutubePlayerComponent } from './youtube-player.component';

describe('YoutubePlayerComponent', () => {
  let component: YoutubePlayerComponent;
  let fixture: ComponentFixture<YoutubePlayerComponent>;
  // The component is opened by the dialog service with a context: its video id comes from the dialog's component instance.
  const dialogRef = { componentRef: { instance: { videoId: 'dQw4w9WgXcQ' } }, close: jasmine.createSpy('close') };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [YoutubePlayerComponent],
      providers: [...appConfig.providers, provideHttpClientTesting(), { provide: NbDialogRef, useValue: dialogRef }]
    })
    .compileComponents();

    fixture = TestBed.createComponent(YoutubePlayerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('takes the video id from the dialog context', () => {
    expect(component.videoId).toBe('dQw4w9WgXcQ');
  });
});
